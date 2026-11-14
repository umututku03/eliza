// Deterministic control (no model) in its own process: the frozen task through stock v2's WALLET router with
// oracle-computed amounts and conventional reconciliation, against the fork RPC fault proxy. Each step is
// confirmed the way a user does (a first call, then "yes" with the same parameters).
// Usage (repo root): bun --conditions=eliza-source research/agent-harness-v2/control-child-v2.ts <spec.json> <out.json>
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Address,
  createPublicClient,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import { mainnet } from "viem/chains";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
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
  const reconcile = async () => {
    // Wait through the allowed lag window before treating missing evidence as a dropped send.
    for (let i = 0; i <= spec.reconcileSeconds; i++) {
      if (await visible()) {
        steps.push({ reconciled: "proceeds visible", afterSeconds: elapsed() });
        return;
      }
      if (i < spec.reconcileSeconds) await Bun.sleep(1000);
    }
    if (
      !resent &&
      (await missing()) &&
      (await pub.getTransactionCount({
        address: spec.sender,
        blockTag: "latest",
      })) === beforeNonce
    ) {
      resent = true;
      steps.push({ resent_after_drop: true, afterSeconds: elapsed() });
      await sell();
      if (await visible()) {
        steps.push({ reconciled: "proceeds visible", afterSeconds: elapsed() });
        return;
      }
    }
    throw new Error("Sale did not reconcile");
  };
  await sell();
  await reconcile();
  // Fixed wait only for the predeclared emulated-reorg control: confirmation must precede orphaning.
  if (spec.scenario === "sale_reorged") await Bun.sleep(25_000);
  if (!(await visible())) {
    if (
      !resent &&
      (await missing()) &&
      (await pub.getTransactionCount({
        address: spec.sender,
        blockTag: "latest",
      })) === beforeNonce
    ) {
      resent = true;
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
  if (amount !== null) {
    const swap = await confirmed({
      action: "swap",
      target: "mainnet",
      fromToken: X.address,
      toToken: Y.address,
      amount: formatUnits(amount, X.decimals),
      slippageBps: 300,
    });
    steps.push({ swap: brief(swap) });
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
  JSON.stringify({ steps, declared, error, refusal }, null, 2),
);
await runtime.stop?.().catch(() => {});
process.exit(0);
