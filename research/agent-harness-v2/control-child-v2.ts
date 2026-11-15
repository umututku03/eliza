// Deterministic control (no model) in its own process: the frozen task through stock v2's WALLET router with
// oracle-computed amounts and conventional reconciliation, against the fork RPC fault proxy. Each step is
// confirmed the way a user does (a first call, then "yes" with the same parameters).
// Usage (repo root): bun --conditions=eliza-source research/agent-harness-v2/control-child-v2.ts <spec.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import { reconcileControlSale } from "./reconcile-control";
import {
  type Address,
  createPublicClient,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { mainnet } from "viem/chains";

// The reference is conventional reconciliation in every off-chain treatment arm.
// On-chain plan/checkpoint conditions still apply via the spec's wallet configuration.
// Otherwise a conservative treatment failure aborts its own reference before it can be measured.
const REFERENCE_POLICY = "stock_reconciliation";
for (const name of ["EVM_EVIDENCE_MODE", "EVM_EVIDENCE_LAYER", "EVM_EVIDENCE_ABLATE", "EVM_EVIDENCE_READ_URLS", "EVM_EVIDENCE_DECISION_LOG"]) delete process.env[name];
const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
// Workflow tasks (WS-W: A1 approve_swap, L1 supply) use a framework-free control: ElizaOS cannot supply to Aave, and one
// control for both agents keeps the oracle reference identical. It signs with the agent key through the fault proxy
// and reconciles the critical transaction from chain state like a careful client; swap2 tasks keep the ElizaOS control.
if (spec.workflow) {
  await workflowControl();
  process.exit(0);
}
async function workflowControl() {
  const { createWalletClient, encodeFunctionData, parseAbi, parseEther } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { quote, balance } = await import("./fork-oracle");
  const transport = http(spec.forkProxyUrl, { retryCount: 0 });
  const pub = createPublicClient({ chain: mainnet, transport });
  const signer = createWalletClient({ chain: mainnet, transport, account: privateKeyToAccount(spec.privateKey) });
  const X = spec.x, Y = spec.y, W = spec.wallet as Address;
  const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
  const ROUTER = parseAbi([
    "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  ]);
  const POOL = parseAbi(["function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)"]);
  const steps: any[] = [];
  let declared = "INFEASIBLE", error: string | null = null;
  const started = Date.now();
  const elapsed = () => Math.floor((Date.now() - started) / 1000);
  const nonce = () => pub.getTransactionCount({ address: spec.sender, blockTag: "latest" });
  const allowance = (spender: Address) => pub.readContract({ address: X.address, abi: ERC20, functionName: "allowance", args: [W, spender] });
  const send = (to: Address, data: `0x${string}`, value = 0n, gas = 400000n) => signer.sendTransaction({ to, data, value, gas } as any);
  /** Polls the receipt (fetching it also lets an emulated reorg arm); null if none within `seconds`. */
  const receipt = async (hash: `0x${string}`, seconds: number) => {
    for (let i = 0; i <= seconds * 4; i++) {
      const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
      if (r) return r;
      await Bun.sleep(250);
    }
    return null;
  };
  const mustMine = async (label: string, hash: `0x${string}`) => {
    const r = await receipt(hash, 60);
    steps.push({ [label]: hash, status: r?.status ?? "no_receipt", afterSeconds: elapsed() });
    if (r?.status !== "success") throw new Error(`${label} did not succeed`);
  };
  const missing = async (hash: `0x${string}`) => {
    try { await pub.getTransaction({ hash }); return false; }
    catch (e) { if ((e as Error).name === "TransactionNotFoundError") return true; throw e; }
  };
  /** The critical transaction: send, then wait for its effect through the allowed fault windows. Resend once only
   *  when the effect never appeared, the transaction is unknown and the sender's nonce did not move (a dropped send). */
  const critical = async (label: string, build: () => Promise<`0x${string}`>, landed: () => Promise<boolean>) => {
    const before = await nonce();
    let hash = await build();
    steps.push({ [label]: hash, afterSeconds: elapsed() });
    await receipt(hash, 10);
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let i = 0; i <= spec.reconcileSeconds; i++) {
        if (await landed()) { steps.push({ reconciled: `${label} effect visible`, afterSeconds: elapsed() }); return before; }
        if (i < spec.reconcileSeconds) await Bun.sleep(1000);
      }
      if (attempt === 0 && (await missing(hash)) && (await nonce()) === before) {
        hash = await build();
        steps.push({ [`${label}_resent_after_drop`]: hash, afterSeconds: elapsed() });
        await receipt(hash, 10);
      } else break;
    }
    throw new Error(`${label} did not reconcile`);
  };
  const reorgs = spec.scenario === "sale_reorged";
  const deadline = async () => (await pub.getBlock()).timestamp + 1200n;
  try {
    if (spec.workflow === "approve_swap") {
      const amount = BigInt(spec.swapXUnits), spender = spec.spender as Address, path = [X.address, spec.weth, Y.address] as Address[];
      const goal = parseUnits(spec.goalY, Y.decimals);
      const approveAndSwap = async () => {
        const before = await critical("approval",
          () => send(X.address, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [spender, amount] }), 0n, 100000n),
          async () => (await allowance(spender)) >= amount);
        const minOut = (await quote(pub, amount, path)) * 97n / 100n;
        await mustMine("swap", await send(spender, encodeFunctionData({ abi: ROUTER, functionName: "swapExactTokensForTokens",
          args: [amount, minOut, path, W, await deadline()] })));
        return before;
      };
      const before = await approveAndSwap();
      if (reorgs) await Bun.sleep((spec.reorgDelayMs ?? 20_000) + 5_000);
      if ((await balance(pub, Y.address, W)) < goal) {
        if (!(reorgs && (await nonce()) === before)) throw new Error("Swap output disappeared without safe resend evidence");
        steps.push({ resent_after_reorg: true, afterSeconds: elapsed() });
        await approveAndSwap();
      }
      const y = await balance(pub, Y.address, W), x = await balance(pub, X.address, W), left = await allowance(spender);
      steps.push({ finalY: formatUnits(y, Y.decimals), finalX: formatUnits(x, X.decimals), finalAllowance: left.toString() });
      if (y >= goal && x >= parseUnits(spec.reserveX, X.decimals) && left === 0n) declared = "COMPLETED";
    } else if (spec.workflow === "supply") {
      const amount = BigInt(spec.supplyXUnits), pool = spec.pool as Address, tol = BigInt(spec.aTokenToleranceUnits);
      const sale = parseEther(spec.saleEth), salePath = [spec.weth, X.address] as Address[];
      const minOut = (await quote(pub, sale, salePath)) * 97n / 100n;
      await mustMine("sale", await send(spec.router, encodeFunctionData({ abi: ROUTER, functionName: "swapExactETHForTokens",
        args: [minOut, salePath, W, await deadline()] }), sale, 300000n));
      await mustMine("pool_approval", await send(X.address, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [pool, amount] }), 0n, 100000n));
      const supplied = async () => (await balance(pub, Y.address, W)) + tol >= amount;
      const supply = () => critical("supply",
        () => send(pool, encodeFunctionData({ abi: POOL, functionName: "supply", args: [X.address, amount, W, 0] })), supplied);
      const before = await supply();
      if (reorgs) await Bun.sleep((spec.reorgDelayMs ?? 20_000) + 5_000);
      if (!(await supplied())) {
        if (!(reorgs && (await nonce()) === before)) throw new Error("Supply disappeared without safe resend evidence");
        steps.push({ resent_after_reorg: true, afterSeconds: elapsed() });
        await supply();
      }
      const a = await balance(pub, Y.address, W), x = await balance(pub, X.address, W);
      steps.push({ aToken: formatUnits(a, Y.decimals), finalX: formatUnits(x, X.decimals) });
      if (a + tol >= amount && x >= parseUnits(spec.reserveX, X.decimals)) declared = "COMPLETED";
    } else throw new Error(`unknown workflow ${spec.workflow}`);
  } catch (e) {
    error = (e as Error).message;
  }
  writeFileSync(process.argv[3], JSON.stringify({ steps, declared, error, refusal: null, referencePolicy: REFERENCE_POLICY }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
Object.assign(process.env, {
  ELIZA_BENCH_DISABLE_DOTENV: "1",
  SECRET_SALT: "agent-harness-v2-fixed-salt",
});
const { AgentRuntime, stringToUuid } = await import("@elizaos/core");
const { createAssistantPlugin } = await import("@elizaos/plugin-assistant");
const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
const openaiPlugin = (await import("@elizaos/plugin-openai")).default;
const { walletPlugin, walletRouterAction } = await import(
  "@elizaos/plugin-wallet"
);
const { quote, balance } = await import("./fork-oracle");
const X = spec.x,
  Y = spec.y,
  PATH = [X.address, spec.weth, Y.address] as Address[];
/** Smallest X amount (cent steps) whose Y quote on the task's path reaches `target`, or null if `budget` cannot. */
async function minimalXFor(target: bigint, budget: bigint) {
  if (budget <= 0n || (await quote(pub, budget, PATH)) < target) return null;
  const cent = 10n ** BigInt(X.decimals - 2);
  let lo = 0n,
    hi = budget / cent;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await quote(pub, mid * cent, PATH)) >= target) hi = mid;
    else lo = mid + 1n;
  }
  return lo * cent;
}

const pub = createPublicClient({
  chain: mainnet,
  transport: http(spec.forkProxyUrl, { retryCount: 0 }),
});
const runtime = new AgentRuntime({
  agentId: stringToUuid(`control-${spec.scenario}`),
  character: {
    name: "Agent",
    bio: ["A wallet assistant."],
    settings: {
      chains: { evm: ["mainnet"] },
      secrets: {
        EVM_PRIVATE_KEY: spec.privateKey,
        ETHEREUM_PROVIDER_MAINNET: spec.forkProxyUrl,
        EVM_SWAP_UNISWAP_V2_ROUTER: spec.router,
        EVM_SWAP_AGGREGATORS: "uniswapV2",
        ELIZA_WALLET_BACKEND: "local",
        SOLANA_NO_ACTIONS: "true",
        OPENAI_API_KEY: "unused",
        OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
        ...(spec.planJson ? { EVM_PLAN_GUARD_PLAN: spec.planJson } : {}),
        EVM_WALLET_TRACKED_TOKENS: spec.trackedTokens,
        PGLITE_DATA_DIR: `memory://control-${spec.scenario}-${Date.now()}`,
      },
    },
  } as any,
  plugins: [
    createAssistantPlugin(),
    sqlPlugin,
    openaiPlugin,
    walletPlugin as any,
  ],
  logLevel: "error",
});
await runtime.initialize();
await runtime.getServiceLoadPromise("wallet-backend" as any);
const entityId = stringToUuid("control-user"),
  roomId = stringToUuid(`control-room-${spec.scenario}`);
const msg = (text: string) =>
  ({
    id: crypto.randomUUID(),
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: { text },
    createdAt: Date.now(),
  }) as any;
const confirmed = async (parameters: Record<string, unknown>) => {
  const first = await walletRouterAction.handler(
    runtime,
    msg("please do this swap"),
    undefined,
    { parameters } as any,
  );
  if (!first?.data?.requiresConfirmation)
    throw new Error(
      `expected a confirmation request: ${JSON.stringify(first?.data).slice(0, 200)}`,
    );
  return walletRouterAction.handler(runtime, msg("yes, confirm"), undefined, {
    parameters,
  } as any);
};
const brief = (r: any) => ({
  success: r?.success,
  error: r?.data?.error ?? null,
  text: String(r?.text ?? "").slice(0, 300),
});

const steps: any[] = [];
let declared = "INFEASIBLE",
  error: string | null = null,
  refusal: string | null = null;
try {
  const started = Date.now();
  const beforeX = await balance(pub, X.address as Address, spec.wallet);
  const beforeNonce = await pub.getTransactionCount({
    address: spec.sender,
    blockTag: "latest",
  });
  const params = {
    action: "swap",
    target: "mainnet",
    fromToken: "ETH",
    toToken: X.address,
    amount: spec.saleEth,
    slippageBps: 300,
  };
  let hash: `0x${string}` | null = null;
  let resent = false;
  const elapsed = () => Math.floor((Date.now() - started) / 1000);
  const sell = async () => {
    let result: any;
    try {
      result = await confirmed(params);
    } catch (e) {
      result = { success: false, text: (e as Error).message };
    }
    hash =
      result?.data?.transactionHash ??
      String(result?.text ?? "").match(/0x[0-9a-fA-F]{64}/)?.[0] ??
      null;
    steps.push({ sale: brief(result), hash, afterSeconds: elapsed() });
    return result;
  };
  const visible = async () =>
    (await balance(pub, X.address as Address, spec.wallet)) > beforeX;
  const missing = async () => {
    if (!hash)
      throw new Error("Cannot reconcile sale without its transaction hash");
    try {
      await pub.getTransaction({ hash });
      return false;
    } catch (e) {
      if ((e as Error).name === "TransactionNotFoundError") return true;
      throw e;
    }
  };
  const reconcile = () => reconcileControlSale({
    seconds: spec.reconcileSeconds,
    visible,
    mayResend: () => !resent,
    missing,
    nonceUnchanged: async () => (await pub.getTransactionCount({ address: spec.sender, blockTag: "latest" })) === beforeNonce,
    resend: async () => {
      resent = true;
      steps.push({ resent_after_drop: true, afterSeconds: elapsed() });
      await sell();
    },
    sleep: (ms) => Bun.sleep(ms),
    reconciled: () => { steps.push({ reconciled: "proceeds visible", afterSeconds: elapsed() }); },
  });
  await sell();
  await reconcile();
  // Block of the confirmed sale as first seen (sale_reorged_reincluded: a later block means it was re-included).
  const saleBlockNow = async () => {
    try {
      return Number((await pub.getTransactionReceipt({ hash: hash! })).blockNumber);
    } catch (e) {
      if ((e as Error).name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }
  };
  const reincluded = spec.scenario === "sale_reorged_reincluded";
  const seenBlock = reincluded ? await saleBlockNow() : null;
  let observedReinclusion = false;
  const observeReinclusion = async () => {
    if (!reincluded || observedReinclusion) return;
    const now = await saleBlockNow();
    if (now !== null && seenBlock !== null && now !== seenBlock) {
      observedReinclusion = true;
      steps.push({ observed_reinclusion: { hash, fromBlock: seenBlock, toBlock: now }, afterSeconds: elapsed() });
    }
  };
  // Wait only for the predeclared emulated-reorg controls: confirmation must precede orphaning (reorg delay + 5 s).
  // With --reorg-trigger=next-send the reorg fires at the control's next send (step 2) instead; the same wait keeps
  // that send past the floor, so it is forwarded at once rather than deferred.
  const reorgs = ["sale_reorged", "dropped_then_reorg", "sale_reorged_reincluded"].includes(spec.scenario);
  if (reorgs) await Bun.sleep((spec.reorgDelayMs ?? 20_000) + 5_000);
  // Re-included sale: the correct client does not re-send; it sees the sale again (same hash, later block) and goes on.
  await observeReinclusion();
  let resentAfterReorg = false;
  if (!(await visible())) {
    if (
      reorgs &&
      !resentAfterReorg &&
      (await missing()) &&
      (await pub.getTransactionCount({
        address: spec.sender,
        blockTag: "latest",
      })) === beforeNonce
    ) {
      resentAfterReorg = true;
      steps.push({ resent_after_reorg: true, afterSeconds: elapsed() });
      await sell();
      await reconcile();
    } else
      throw new Error("Sale proceeds disappeared without safe resend evidence");
  }
  // Step 2 within the user's constraints: spend at most balance - reserve (the actual surplus, which equals the
  // signing-time budget unless the market state moved it) and reach the goal with the smallest such amount.
  // checkpoint_approx commits step 2's exact amount (the budget): a correct agent spends it when that meets the
  // constraints; otherwise it tries the goal-reaching amount, which the layer is predeclared to refuse.
  const goal = parseUnits(spec.goalY, Y.decimals),
    budget = BigInt(spec.budgetXUnits);
  const stepTwo = async () => {
    const held = await balance(pub, X.address as Address, spec.wallet),
      reserve = parseUnits(spec.reserveX, X.decimals);
    const surplus = held > reserve ? held - reserve : 0n;
    const budgetWithin =
      budget <= surplus && (await quote(pub, budget, PATH)) >= goal;
    const amount =
      spec.condition === "checkpoint_approx" && budgetWithin
        ? budget
        : await minimalXFor(goal, surplus);
    steps.push({
      heldX: formatUnits(held, X.decimals),
      surplusX: formatUnits(surplus, X.decimals),
      budgetWithinConstraints: budgetWithin,
      oracleStep2X: amount === null ? null : formatUnits(amount, X.decimals),
    });
    if (amount === null) return null;
    let swap: any;
    try {
      swap = await confirmed({
        action: "swap",
        target: "mainnet",
        fromToken: X.address,
        toToken: Y.address,
        amount: formatUnits(amount, X.decimals),
        slippageBps: 300,
      });
    } catch (e) {
      swap = { success: false, text: (e as Error).message };
    }
    steps.push({ swap: brief(swap) });
    return swap;
  };
  let swap = await stepTwo();
  // next-send reorg (sale_reorged, dropped_then_reorg): step 2's first send triggered the reorg and, signed after the
  // now-orphaned sale, waits in the pool behind the nonce the orphan freed. Re-send the sale once (only if it is gone
  // and the sender's nonce is back to its pre-sale value); the stranded send then mines after it. Redo step 2 only if
  // the goal is still unmet.
  if (
    swap &&
    swap.success !== true &&
    reorgs &&
    !reincluded &&
    spec.reorgTrigger === "next-send" &&
    !resentAfterReorg &&
    (await missing()) &&
    (await pub.getTransactionCount({
      address: spec.sender,
      blockTag: "latest",
    })) === beforeNonce
  ) {
    resentAfterReorg = true;
    steps.push({ resent_after_reorg: true, stranded_follow_up: true, afterSeconds: elapsed() });
    await sell();
    await reconcile();
    if ((await balance(pub, Y.address as Address, spec.wallet)) >= goal) {
      steps.push({ step2_mined_after_resent_sale: true, afterSeconds: elapsed() });
      swap = { success: true };
    } else swap = await stepTwo();
  }
  // Random follow-up faults are only receipt hiding/stale reads, never drops or reorgs. After a failed
  // tool result, wait out the predeclared window, then check the goal BEFORE any retry. A mined swap
  // needs a truthful completion report; an approval-only attempt may still require the swap itself.
  if (spec.reconcileFollowup && swap && swap.success !== true) {
    await Bun.sleep(spec.reconcileSeconds * 1000);
    if ((await balance(pub, Y.address as Address, spec.wallet)) >= goal) {
      steps.push({ followup_reconciled: "goal visible after fault window", afterSeconds: elapsed() });
      swap = { success: true };
    } else {
      steps.push({ followup_reconciled: "goal absent after fault window; retry step 2", afterSeconds: elapsed() });
      swap = await stepTwo();
    }
  }
  await observeReinclusion();
  if (swap) {
    if (swap?.success !== true) {
      refusal = `${brief(swap).error ?? ""} ${brief(swap).text}`.trim();
      throw new Error(`control step 2 failed: ${brief(swap).text}`);
    }
    declared = "COMPLETED";
  }
} catch (e) {
  error = (e as Error).message;
}
writeFileSync(
  process.argv[3],
  JSON.stringify({ steps, declared, error, refusal, referencePolicy: REFERENCE_POLICY }, null, 2),
);
await runtime.stop?.().catch(() => {});
process.exit(0);
