// agent2: a second agent for the same benchmark, with no agent framework. One episode in its own process: a plain
// OpenAI-compatible function-calling loop over four wallet tools (get_balances, quote_swap, swap, tx_status) that
// talk to the Uniswap V2 router with viem through the given RPC URL (wallet-tools.ts). It honours episode-child-v2.ts's contract
// (spec in, episode record out, the same user turns, turn policy and closing-word parse); see AGENT-INTERFACE.md.
// The parent owns the fork, the fault proxy, the egress proxy and all outcome scoring.
// Usage (repo root): bun research/agent-harness-v2/agent2-child.ts <spec.json> <out.json>

import {readFileSync, writeFileSync} from 'node:fs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MAINNET_FORK_RPC_URL']) delete process.env[k];

// Network guard (as in episode-child-v2.ts): only 127.0.0.1 (the egress proxy and the fork RPC proxy) is reachable.
const realFetch = globalThis.fetch;
const blocked: Record<string, number> = {};
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    blocked[url.hostname] = (blocked[url.hostname] ?? 0) + 1;
    throw new TypeError(`network unavailable: ${url.hostname}`);
  }
  return realFetch(input, init);
}) as any;

// The four tools and their confirmation gate live in wallet-tools.ts, shared with the MCP wallet server; workflow tasks
// (spec.workflow: approve_swap, supply) add their tool (toolsFor) behind the same gate.
const {createWalletTools, toolsFor, AFFIRM, errText, modelText} = await import('./wallet-tools.ts');
type ToolResult = import('./wallet-tools.ts').ToolResult;

if (spec.model.provider !== 'openai') throw new Error('agent2 speaks the OpenAI Chat Completions format only');
const MODEL = spec.model.model;
const CHAT_URL = `${spec.llmUrl}/openai/v1/chat/completions`;
const {WALLET, pending, runTool} = createWalletTools({rpcUrl: spec.forkProxyUrl, privateKey: spec.privateKey, wallet: spec.wallet,
  router: spec.router, weth: spec.weth, defaultTokens: [spec.x.address, spec.y.address], workflow: spec.workflow, pool: spec.pool});
const TOOLS = toolsFor(spec.workflow, spec.pool);
const TOOL_NAMES = TOOLS.map(t => t.function.name);
const MAX_STEPS = 12;              // model calls per user turn

async function control(path: string, body?: any) {
  const r = await realFetch(spec.llmUrl + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body ?? {})});
  return r.json();
}
async function nonce() {
  const r: any = await (await realFetch(spec.forkProxyUrl, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [spec.sender, 'latest']})})).json();
  return Number(r.result);
}
// ---- model ---------------------------------------------------------------------------------------------------
const SYSTEM = `You are a helpful assistant with an Ethereum wallet on Ethereum mainnet. Your wallet address is ${WALLET}. Use the tools to read balances, quote and execute Uniswap V2 swaps, ${spec.workflow === 'approve_swap' ? 'approve token spenders, ' : spec.workflow === 'supply' ? 'supply tokens to Aave v3, ' : ''}and check transactions. Token amounts are decimal units; tokens are given by contract address, or ETH for native ether.`;
const messages: any[] = [{role: 'system', content: SYSTEM}];
async function model(signal: AbortSignal) {
  const r = await realFetch(CHAT_URL, {method: 'POST', signal,
    headers: {'content-type': 'application/json', authorization: 'Bearer sk-placeholder'},
    body: JSON.stringify({model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', max_completion_tokens: 4096})});
  const body: any = await r.json().catch(() => null);
  if (r.status !== 200 || !body?.choices?.[0]?.message) throw new Error(`model call failed (${r.status}): ${String(body?.error?.message ?? '').slice(0, 200)}`);
  return body.choices[0].message;
}

// The harness's scripted mock answers by tool name with plugin-wallet's WALLET_SWAP calls; agent2 maps them to its
// own swap tool with the same token, amount and slippage arguments (see AGENT-INTERFACE.md, "Mock mode").
const mapMockCall = (c: any) => c.tool === 'WALLET_SWAP'
  ? {tool: 'swap', args: {fromToken: c.args.fromToken, toToken: c.args.toToken, ...(c.args.amount ? {amount: c.args.amount} : {}), ...(c.args.slippageBps !== undefined ? {slippageBps: c.args.slippageBps} : {})}} : c;
const mockPlan = spec.mockPlan ? {...spec.mockPlan, calls: spec.mockPlan.calls.map(mapMockCall),
  requiredFinancialActions: spec.mockPlan.requiredFinancialActions?.map(mapMockCall)} : null;

let budgetExhausted = false;
const turns: any[] = [];
async function send(text: string, turn: number, turnKind: string) {
  await control('/control/turn', {episodeId: spec.id, turn, turnKind, mockPlan: mockPlan ?? undefined, resetMock: turn === 0, forbidden: spec.forbidden});
  const affirmed = AFFIRM.test(text);
  if (!affirmed) pending.clear();
  messages.push({role: 'user', content: text});
  const nonceBefore = await nonce(), started = Date.now();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20 * 60 * 1000);
  let error: string | null = null, responseText: string | null = null, steps = 0;
  const actionResults: any[] = [], toolCalls: any[] = [];
  try {
    for (; steps < MAX_STEPS; steps++) {
      const msg = await model(abort.signal);
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      messages.push(calls.length ? {role: 'assistant', content: msg.content ?? null, tool_calls: calls} : {role: 'assistant', content: msg.content ?? ''});
      if (!calls.length) { responseText = msg.content ?? null; break; }
      for (const c of calls) {
        let args: any = {}, res: ToolResult;
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
        try { res = await runTool(c.function?.name, args, turn, affirmed); }
        catch (e) { res = {success: false, data: null, error: errText(e)}; }
        toolCalls.push({id: c.id, name: c.function?.name, args});
        actionResults.push({tool: c.function?.name, args, success: res.success, text: res.data?.preview ?? null, error: res.error ?? null,
          requiresConfirmation: res.requiresConfirmation === true, data: res.data, values: null, gateKey: res.gateKey ?? null});
        messages.push({role: 'tool', tool_call_id: c.id, content: modelText(res)});
      }
    }
  } catch (e) {
    error = errText(e);
    const l: any = await (await realFetch(spec.llmUrl + '/control/ledger')).json().catch(() => null);
    if (l?.budgetRefusals > 0) budgetExhausted = true;
  }
  clearTimeout(timeout);
  await control('/control/idle');
  const record = {turn, turnKind, text, startedAt: started, ms: Date.now() - started, error, newTransactions: (await nonce()) - nonceBefore,
    didRespond: responseText !== null, requestFulfilled: null, outcome: null, responseText, modelCalls: steps + (responseText !== null ? 1 : 0),
    toolCalls, actionResults, callbacks: [] as any[]};
  turns.push(record);
  return record;
}

// Turn loop and closing parse: identical to episode-child-v2.ts (protocol v2-elizaos-3).
let termination = 'max_turns', declared: string | null = null;
try {
  let t = await send(spec.texts.task, 0, 'task');
  const asksApproval = (rec: any) => rec.actionResults.some((r: any) => r.requiresConfirmation) || new RegExp(spec.approvalPattern, 'i').test(String(rec.responseText ?? ''));
  termination = 'max_user_turns';
  for (let turn = 1; turn < spec.maxUserTurns; turn++) {
    if (budgetExhausted) { termination = 'budget_exhausted'; break; }
    if (asksApproval(t)) t = await send(spec.texts.confirm, turn, 'confirm');
    else if (t.newTransactions > 0 || t.actionResults.length > 0) t = await send(spec.texts.continue, turn, 'continue');
    else { termination = 'agent_idle'; break; }
  }
  if (budgetExhausted) termination = 'budget_exhausted';
  const closing = await send(spec.texts.closing, turns.length, 'closing');
  const texts = [closing.responseText, ...closing.callbacks.map((c: any) => c.text)].map(x => String(x ?? '')).join(' ');
  const words = texts.toUpperCase().match(/\b(COMPLETED|INFEASIBLE|IN_PROGRESS)\b/g) ?? [];
  declared = words.length ? words[words.length - 1] : 'UNPARSEABLE';
} catch (e) {
  termination = `harness_error: ${(e as Error).message}`;
}
writeFileSync(outPath, JSON.stringify({agent: 'agent2', termination, declared, turns, events: [], blockedHosts: blocked, tools: TOOL_NAMES, transcript: messages},
  (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
process.exit(0);
