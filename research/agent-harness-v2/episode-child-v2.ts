// One stock ElizaOS v2 episode in its own process: builds the runtime (assistant, SQL, one model plugin,
// wallet), drives the user turns and writes the transcript. The parent owns the fork, the fault proxy, the
// egress proxy and all outcome scoring. Adapted from the Spartan harness's agent-episode-child.ts
// (umututku03/spartan-agent c47d7c3); the network guard, turn control and declared-word parse are unchanged.
// Usage (repo root): bun --conditions=eliza-source research/agent-harness-v2/episode-child-v2.ts <spec.json> <out.json>

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const outPath = process.argv[3];

// Settings read from process.env by core and plugins; set before they load.
Object.assign(process.env, {
  ELIZA_BENCH_DISABLE_DOTENV: "1",
  ELIZA_TRAJECTORY_LOGGING: "1",
  ELIZA_TRAJECTORY_DIR: spec.trajectoryDir,
  ELIZA_ANTHROPIC_DISABLE_STREAM: "1",
  SECRET_SALT: "agent-harness-v2-fixed-salt",
  WALLET_ANALYTICS_ENABLED: "false", // Declare the localhost-only network policy to capability selection.
});
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MAINNET_FORK_RPC_URL"])
  delete process.env[k];
mkdirSync(spec.trajectoryDir, { recursive: true });

// Network guard: this process may only reach 127.0.0.1 (proxies). Live market data, real-mainnet RPC
// fallbacks, HTTP swap aggregators and any direct provider call are impossible from the agent process.
const realFetch = globalThis.fetch;
const blocked: Record<string, number> = {};
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(
    typeof input === "string" ? input : (input.url ?? String(input)),
  );
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    blocked[url.hostname] = (blocked[url.hostname] ?? 0) + 1;
    throw new TypeError(`network unavailable: ${url.hostname}`); // neutral wording: may surface in model-visible notes
  }
  return realFetch(input, init);
}) as any;

const {
  AgentRuntime,
  ChannelType,
  ModelType,
  createMessageMemory,
  stringToUuid,
} = await import("@elizaos/core");
const { createAssistantPlugin } = await import("@elizaos/plugin-assistant");
const sqlPlugin = (await import("@elizaos/plugin-sql")).default;
const { walletPlugin } = await import("@elizaos/plugin-wallet");
const { provider, model } = spec.model;
const modelPlugin =
  provider === "openai"
    ? (await import("@elizaos/plugin-openai")).default
    : (await import("@elizaos/plugin-anthropic")).default;

async function control(path: string, body?: any) {
  const r = await realFetch(spec.llmUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}
async function nonce() {
  const r: any = await (
    await realFetch(spec.forkProxyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionCount",
        params: [spec.sender, "latest"],
      }),
    })
  ).json();
  return Number(r.result);
}

// Deterministic local embeddings for both model families (Anthropic has no embedding handler; OpenAI's would
// call the provider), registered above the model plugin's priority.
const DIMS = 1536;
function hashEmbedding(text: string) {
  const v = new Array(DIMS).fill(0);
  for (const tok of String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    const h = createHash("sha256").update(tok).digest();
    v[h.readUInt32BE(0) % DIMS] += h[4] & 1 ? 1 : -1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
const embeddingPlugin = {
  name: "local-embeddings",
  description: "Deterministic local text embeddings.",
  priority: 1000,
  models: {
    [ModelType.TEXT_EMBEDDING]: async (_rt: unknown, params: any) =>
      hashEmbedding(typeof params === "string" ? params : (params?.text ?? "")),
  },
};

const slots = [
  "NANO",
  "SMALL",
  "MEDIUM",
  "LARGE",
  "MEGA",
  "RESPONSE_HANDLER",
  "ACTION_PLANNER",
];
const prefix = provider === "openai" ? "OPENAI" : "ANTHROPIC";
const modelSecrets: Record<string, string> = Object.fromEntries(
  slots.map((s) => [`${prefix}_${s}_MODEL`, model]),
);
const idn = spec.identity;
const agentId = stringToUuid(`agent-${idn.room}`);
const runtime = new AgentRuntime({
  agentId,
  character: {
    name: "Agent",
    bio: ["A helpful assistant with an Ethereum wallet."],
    settings: {
      chains: { evm: ["mainnet"] },
      secrets: {
        EVM_PRIVATE_KEY: spec.privateKey,
        ETHEREUM_PROVIDER_MAINNET: spec.forkProxyUrl,
        EVM_SWAP_UNISWAP_V2_ROUTER: spec.router,
        EVM_SWAP_AGGREGATORS: "uniswapV2",
        ELIZA_WALLET_BACKEND: "local",
        SOLANA_NO_ACTIONS: "true",
        PGLITE_DATA_DIR: `memory://${idn.room}`,
        ...(spec.planJson ? { EVM_PLAN_GUARD_PLAN: spec.planJson } : {}),
        EVM_WALLET_TRACKED_TOKENS: spec.trackedTokens,
        ...(provider === "openai"
          ? {
              OPENAI_API_KEY: "sk-harness-placeholder",
              OPENAI_BASE_URL: `${spec.llmUrl}/openai/v1`,
            }
          : {
              ANTHROPIC_API_KEY: "sk-ant-harness-placeholder",
              ANTHROPIC_BASE_URL: `${spec.llmUrl}/anthropic/v1`,
            }),
        ...modelSecrets,
      },
    },
  } as any,
  plugins: [
    createAssistantPlugin(),
    sqlPlugin,
    modelPlugin,
    embeddingPlugin as any,
    walletPlugin as any,
  ],
  logLevel: "warn",
});

const events: any[] = [];
await control("/control/turn", {
  episodeId: `${spec.id}#init`,
  turn: -1,
  turnKind: "init",
  forbidden: spec.forbidden,
}); // init may probe models
await runtime.initialize();
await runtime.getServiceLoadPromise("wallet-backend" as any);
await control("/control/idle");
for (const type of ["ACTION_STARTED", "ACTION_COMPLETED"])
  runtime.registerEvent(type, async (p: any) => {
    events.push({
      type,
      at: Date.now(),
      action: p?.content?.actions ?? p?.actionName ?? null,
      data: p?.content ?? null,
    });
  });

// Every model-visible identifier is a neutral random value supplied by the parent (spec.identity).
const roomId = stringToUuid(idn.room),
  worldId = stringToUuid(idn.world),
  userId = stringToUuid(idn.participant);
await runtime.ensureConnection({
  entityId: userId,
  roomId,
  worldId,
  userName: "User",
  source: "chat",
  channelId: idn.channel,
  type: ChannelType.DM,
  messageServerId: stringToUuid(idn.world),
  metadata: { ownership: { ownerId: userId } },
} as any);

const turns: any[] = [];
async function send(text: string, turn: number, turnKind: string) {
  await control("/control/turn", {
    episodeId: spec.id,
    turn,
    turnKind,
    mockPlan: spec.mockPlan ?? undefined,
    resetMock: turn === 0,
    forbidden: spec.forbidden,
  });
  const callbacks: any[] = [];
  const msg: any = createMessageMemory({
    id: randomUUID(),
    entityId: userId,
    roomId,
    content: { text, source: "chat", channelType: ChannelType.DM },
  } as any);
  const nonceBefore = await nonce(),
    started = Date.now();
  let error: string | null = null,
    result: any = null;
  // Stop the turn when the approved budget is exhausted: refused calls cost nothing, but an agent that keeps
  // retrying them only adds noise. The episode then ends as budget_exhausted.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20 * 60 * 1000);
  const watch = setInterval(async () => {
    try {
      const l: any = await (
        await realFetch(spec.llmUrl + "/control/ledger")
      ).json();
      if (l.budgetRefusals > 0) {
        budgetExhausted = true;
        abort.abort();
      }
    } catch {}
  }, 1000);
  try {
    result = await runtime.messageService!.handleMessage(
      runtime,
      msg,
      async (c: any) => {
        callbacks.push(c);
        return [];
      },
      { abortSignal: abort.signal } as any,
    );
  } catch (e) {
    error = (e as Error).message;
  }
  clearInterval(watch);
  clearTimeout(timeout);
  await control("/control/idle");
  const actionResults = (result?.actionResults ?? []).map((r: any) => ({
    success: r.success,
    text: r.text,
    error: r.error ?? r.data?.error ?? null,
    requiresConfirmation: r.data?.requiresConfirmation === true,
    data: r.data ?? null,
    values: r.values ?? null,
  }));
  const record = {
    turn,
    turnKind,
    text,
    startedAt: started,
    ms: Date.now() - started,
    error,
    newTransactions: (await nonce()) - nonceBefore,
    didRespond: result?.didRespond ?? null,
    requestFulfilled: result?.requestFulfilled ?? null,
    outcome: result?.outcome ?? null,
    responseText: result?.responseContent?.text ?? null,
    actionResults,
    callbacks: callbacks.map((c) => ({
      text: c.text,
      actions: c.actions,
      content: c.content ?? null,
    })),
  };
  turns.push(record);
  return record;
}

let termination = "max_turns",
  declared: string | null = null;
let budgetExhausted = false;
try {
  let t = await send(spec.texts.task, 0, "task");
  // User policy (protocol v2-elizaos-3): approve every confirmation the agent asks for, through the confirmation
  // gate or in its reply text (spec.approvalPattern); after a turn that acted (a transaction or a wallet action
  // result) without asking, say "continue"; stop when the agent is idle.
  const asksApproval = (rec: any) =>
    rec.actionResults.some((r: any) => r.requiresConfirmation) ||
    new RegExp(spec.approvalPattern, "i").test(String(rec.responseText ?? ""));
  termination = "max_user_turns";
  for (let turn = 1; turn < spec.maxUserTurns; turn++) {
    if (budgetExhausted) {
      termination = "budget_exhausted";
      break;
    }
    if (asksApproval(t)) t = await send(spec.texts.confirm, turn, "confirm");
    else if (t.newTransactions > 0 || t.actionResults.length > 0)
      t = await send(spec.texts.continue, turn, "continue");
    else {
      termination = "agent_idle";
      break;
    }
  }
  if (budgetExhausted) termination = "budget_exhausted";
  const closing = await send(spec.texts.closing, turns.length, "closing");
  const texts = [
    closing.responseText,
    ...closing.callbacks.map((c: any) => c.text),
  ]
    .map((x) => String(x ?? ""))
    .join(" ");
  const words =
    texts.toUpperCase().match(/\b(COMPLETED|INFEASIBLE|IN_PROGRESS)\b/g) ?? [];
  declared = words.length ? words[words.length - 1] : "UNPARSEABLE";
} catch (e) {
  termination = `harness_error: ${(e as Error).message}`;
}
const memories = await runtime
  .getMemories({ roomId, tableName: "messages", count: 500 } as any)
  .catch(() => []);
writeFileSync(
  outPath,
  JSON.stringify(
    {
      termination,
      declared,
      turns,
      events,
      blockedHosts: blocked,
      roomMemories: (memories as any[]).map((m) => ({
        id: m.id,
        entityId: m.entityId,
        createdAt: m.createdAt,
        content: m.content,
      })),
    },
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
await runtime.stop?.().catch(() => {});
process.exit(0);
