/**
 * Plan-bound execution for EVM swaps (research mode, off by default).
 *
 * With `EVM_PLAN_GUARD_PLAN` set, the user's funds are held by a delegator smart account (MetaMask
 * delegation framework, ERC-7710). The user signed one delegation per plan step to the agent's key
 * (`EVM_PRIVATE_KEY`). The agent cannot send funds directly: every swap is a `redeemDelegations` call.
 * The delegation's caveats then decide on-chain whether it may run:
 * - built-in target, method and recipient caveats;
 * - a plan-step caveat that enforces step order and at most one success per step;
 * - balance-floor caveats ("keep at least R", "end with at least G").
 *
 * The plan JSON is produced where the user signs (outside the agent) and holds only public data:
 * addresses and already-signed, ABI-encoded permission contexts.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { type Address, encodeFunctionData, encodePacked, type Hex, isAddress, isHex, parseAbi } from "viem";
import { NATIVE_TOKEN_ADDRESS, TX_CONFIRMATION_TIMEOUT_MS } from "./constants";
import type { WalletProvider } from "./providers/wallet";
import { EVMError, EVMErrorCode, type SupportedChain } from "./types";

export interface PlanGuardStep {
  readonly step: number;
  readonly fromToken: Address;
  readonly toToken: Address;
  /** Largest input amount the step allows, in base units. */
  readonly maxAmountIn: string;
  readonly permissionContext: Hex;
}
export interface PlanGuardApproval {
  readonly token: Address;
  readonly spender: Address;
  readonly permissionContext: Hex;
}
export interface PlanGuardConfig {
  readonly account: Address;
  readonly delegationManager: Address;
  readonly steps: readonly PlanGuardStep[];
  readonly approvals: readonly PlanGuardApproval[];
}
export interface PlanCall {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
}

const DELEGATION_MANAGER_ABI = parseAbi([
  "function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)",
]);
/** ERC-7579 mode: single call, default (reverting) execution. */
const SINGLE_DEFAULT_MODE = `0x${"00".repeat(32)}` as Hex;

const invalid = (why: string) => new EVMError(EVMErrorCode.INVALID_PARAMS, `Invalid EVM_PLAN_GUARD_PLAN: ${why}`);

/** Parses EVM_PLAN_GUARD_PLAN; null when plan mode is off. A malformed plan is a configuration error. */
export function planGuardFromSettings(runtime: IAgentRuntime): PlanGuardConfig | null {
  const raw = runtime.getSetting("EVM_PLAN_GUARD_PLAN");
  if (raw === null || raw === undefined || raw === "") return null;
  let plan: PlanGuardConfig;
  try {
    plan = (typeof raw === "string" ? JSON.parse(raw) : raw) as PlanGuardConfig;
  } catch {
    throw invalid("not JSON");
  }
  if (!isAddress(plan.account) || !isAddress(plan.delegationManager)) throw invalid("account and delegationManager must be addresses");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) throw invalid("no steps");
  for (const s of plan.steps) {
    if (!Number.isInteger(s.step) || !isAddress(s.fromToken) || !isAddress(s.toToken) || !isHex(s.permissionContext) || !/^\d+$/.test(String(s.maxAmountIn))) {
      throw invalid(`malformed step ${String(s.step)}`);
    }
  }
  for (const a of plan.approvals ?? []) {
    if (!isAddress(a.token) || !isAddress(a.spender) || !isHex(a.permissionContext)) throw invalid("malformed approval");
  }
  return { ...plan, approvals: plan.approvals ?? [] };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tokenKey = (t: string) => (same(t, NATIVE_TOKEN_ADDRESS) ? NATIVE_TOKEN_ADDRESS : t.toLowerCase());

/** Plan steps that could authorise this swap, in plan order. The chain decides which one (if any) may run. */
export function candidateSteps(plan: PlanGuardConfig, fromToken: string, toToken: string, amountIn: bigint): PlanGuardStep[] {
  return plan.steps
    .filter((s) => tokenKey(s.fromToken) === tokenKey(fromToken) && tokenKey(s.toToken) === tokenKey(toToken) && amountIn <= BigInt(s.maxAmountIn))
    .sort((a, b) => a.step - b.step);
}

export function approvalFor(plan: PlanGuardConfig, token: string, spender: string): PlanGuardApproval | undefined {
  return plan.approvals.find((a) => same(a.token, token) && same(a.spender, spender));
}

export function redeemCalldata(permissionContext: Hex, call: PlanCall): Hex {
  return encodeFunctionData({
    abi: DELEGATION_MANAGER_ABI,
    functionName: "redeemDelegations",
    args: [[permissionContext], [SINGLE_DEFAULT_MODE], [encodePacked(["address", "uint256", "bytes"], [call.to, call.value, call.data])]],
  });
}

/** The enforcer's reason from a failed simulation, e.g. "PlanStepEnforcer:step-already-completed". */
export function planRefusalReason(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${String((error as { details?: unknown }).details ?? "")}` : String(error);
  return text.match(/[A-Za-z0-9]+Enforcer:[a-z0-9-]+/)?.[0] ?? text.match(/reason: ([^\n]+)/)?.[1]?.trim() ?? "no reason given";
}

/**
 * Redeems the first permission context whose simulation succeeds, then waits for the receipt.
 * When every candidate is refused, throws a plan refusal with the first candidate's enforcer reason.
 * The message avoids "reverted" so the swap loop does not retry it through another route.
 */
export async function executeThroughPlan(
  walletProvider: WalletProvider,
  chain: SupportedChain,
  plan: PlanGuardConfig,
  contexts: readonly Hex[],
  call: PlanCall,
  what: string
): Promise<Hex> {
  const walletClient = walletProvider.getWalletClient(chain);
  const publicClient = walletProvider.getPublicClient(chain);
  const account = walletClient.account;
  if (!account) throw new EVMError(EVMErrorCode.WALLET_NOT_INITIALIZED, "Wallet account is not available");
  if (contexts.length === 0) {
    throw new EVMError(EVMErrorCode.INVALID_PARAMS, `Refused by the approved plan: ${what} is not a step of the plan`);
  }
  let firstReason: string | null = null;
  for (const context of contexts) {
    const data = redeemCalldata(context, call);
    try {
      await publicClient.call({ account, to: plan.delegationManager, data });
    } catch (error) {
      firstReason ??= planRefusalReason(error);
      continue;
    }
    const hash = await walletClient.sendTransaction({ account, chain: walletClient.chain, to: plan.delegationManager, data, value: 0n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: TX_CONFIRMATION_TIMEOUT_MS });
    if (receipt.status !== "success") {
      throw new EVMError(EVMErrorCode.CONTRACT_REVERT, `Plan redemption for ${what} failed on-chain. Hash: ${hash}`);
    }
    return hash;
  }
  throw new EVMError(EVMErrorCode.INVALID_PARAMS, `Refused by the approved plan (${firstReason}): ${what}`);
}
