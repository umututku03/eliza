// claudecode: Claude Code (the production CLI harness) as the agent under test. One episode in its own process.
// Each user turn is one headless `claude -p` run; turns after the first resume the same session. Claude Code is
// locked down to the MCP wallet server's four tools (mcp-wallet-server.ts, the same implementation and confirmation
// gate as agent2) and talks only to the egress proxy's /anthropic path. It honours episode-child-v2.ts's contract
// (spec in, episode record out, the same user turns, turn policy and closing-word parse); see AGENT-INTERFACE.md.
//
// Lockdown (paper-draft harness-feasibility notes, 2026-11-14):
//   --bare (no CLAUDE.md, hooks, plugins sync, keychain; auth strictly ANTHROPIC_API_KEY), --tools "" (no built-in
//   tools), --strict-mcp-config --mcp-config (only the wallet server), --system-prompt-file (fixed prompt,
//   claudecode-system-prompt.txt, hashed in the manifest), --permission-mode dontAsk with --allowedTools set to the
//   four mcp__wallet__* tools, --disable-slash-commands; isolated CLAUDE_CONFIG_DIR, HOME and working folder with
//   neutral random names (no episode id in any path the CLI may show the model); ANTHROPIC_BASE_URL is the egress
//   proxy, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1. The CLI and the MCP server it starts run under sandbox-exec
//   with outbound network denied except to localhost, the equivalent of the children's fetch guard for a binary.
// Usage (repo root): bun research/agent-harness-v2/claudecode-child.ts <spec.json> <out.json>

import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3];
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MAINNET_FORK_RPC_URL']) delete process.env[k];

// Network guard for this process (as in episode-child-v2.ts); the CLI itself is confined by sandbox-exec below.
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

const {TOOL_NAMES, gateBeginTurn} = await import('./wallet-tools.ts');
const {getAddress} = await import('viem');
const {privateKeyToAccount} = await import('viem/accounts');

if (spec.model.provider !== 'anthropic') throw new Error('claudecode speaks the Anthropic Messages format only');
const llm = new URL(spec.llmUrl);
if (!['127.0.0.1', 'localhost'].includes(llm.hostname)) throw new Error('llmUrl must be the local egress proxy');
const MODEL = spec.model.model;
const HERE = import.meta.dir;
const CLAUDE = Bun.which('claude', {PATH: process.env.PATH ?? ''});
if (!CLAUDE) throw new Error('claude binary not found on PATH');
const SANDBOX = '/usr/bin/sandbox-exec';
if (!existsSync(SANDBOX)) throw new Error('sandbox-exec is required to confine the CLI to localhost');
const claudeVersion = Bun.spawnSync([CLAUDE, '--version'], {env: {PATH: process.env.PATH ?? ''}}).stdout.toString().trim();
export const ALLOWED = TOOL_NAMES.map((n: string) => `mcp__wallet__${n}`);
const WALLET = getAddress(spec.wallet ?? privateKeyToAccount(spec.privateKey).address);

// Isolated, neutrally named folders: the CLI may put its working folder in a model request, and the blinding gate
// refuses any request that contains the episode id.
const base = mkdtempSync(join(tmpdir(), 'w-'));
const dirs = {cfg: join(base, 'c'), home: join(base, 'h'), cwd: join(base, 'd'), priv: join(base, 'p')};
for (const d of Object.values(dirs)) mkdirSync(d, {recursive: true});
const gateFile = join(dirs.priv, 'gate.json'), logPath = join(dirs.priv, 'tools.jsonl'), cfgFile = join(dirs.priv, 'wallet.json');
const mcpFile = join(dirs.priv, 'mcp.json'), promptFile = join(dirs.priv, 'system.txt'), sbFile = join(dirs.priv, 'net.sb');
writeFileSync(cfgFile, JSON.stringify({rpcUrl: spec.forkProxyUrl, privateKey: spec.privateKey, wallet: spec.wallet, router: spec.router,
  weth: spec.weth, tokens: [spec.x.address, spec.y.address], gateFile, logPath}), {mode: 0o600});
writeFileSync(logPath, '');
writeFileSync(mcpFile, JSON.stringify({mcpServers: {wallet: {type: 'stdio', command: process.execPath,
  args: [join(HERE, 'mcp-wallet-server.ts'), `--config=${cfgFile}`], env: {PATH: process.env.PATH ?? ''}}}}));
const promptTemplate = readFileSync(join(HERE, 'claudecode-system-prompt.txt'), 'utf8');
const systemPrompt = promptTemplate.replaceAll('{{WALLET}}', WALLET);
writeFileSync(promptFile, systemPrompt);
writeFileSync(sbFile, ['(version 1)', '(allow default)', '(deny network-outbound)',
  '(allow network-outbound (remote ip "localhost:*"))', '(allow network-outbound (remote unix-socket))'].join('\n') + '\n');
const cliEnv: Record<string, string> = {
  PATH: process.env.PATH ?? '', HOME: dirs.home, CLAUDE_CONFIG_DIR: dirs.cfg,
  ANTHROPIC_BASE_URL: `${spec.llmUrl}/anthropic`, ANTHROPIC_API_KEY: 'sk-placeholder', // the proxy holds the real key
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  // Any background or helper request uses the cohort model, so every request the proxy sees is the cohort's.
  ANTHROPIC_SMALL_FAST_MODEL: MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL, CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
  // A swap waits up to 60 s per transaction and a stale read window lasts minutes; never time a tool call out.
  MCP_TOOL_TIMEOUT: String(30 * 60 * 1000), MCP_TIMEOUT: '60000',
};
const sessionId = randomUUID();
const cliArgs = (turn: number) => [SANDBOX, '-f', sbFile, CLAUDE, '-p', '--bare', '--tools', '', '--strict-mcp-config', '--mcp-config', mcpFile,
  '--system-prompt-file', promptFile, '--model', MODEL, '--output-format', 'stream-json', '--verbose',
  '--permission-mode', 'dontAsk', '--allowedTools', ALLOWED.join(','), '--disable-slash-commands',
  ...(turn === 0 ? ['--session-id', sessionId] : ['--resume', sessionId])];

async function control(path: string, body?: any) {
  const r = await realFetch(spec.llmUrl + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body ?? {})});
  return r.json();
}
async function nonce() {
  const r: any = await (await realFetch(spec.forkProxyUrl, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [spec.sender, 'latest']})})).json();
  return Number(r.result);
}
const errText = (e: any) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

// The harness's scripted mock answers by tool name with plugin-wallet's WALLET_SWAP calls; they map to the MCP swap
// tool with the same token, amount and slippage arguments, exactly as agent2 maps them (AGENT-INTERFACE.md, "Mock mode").
const mapMockCall = (c: any) => c.tool === 'WALLET_SWAP'
  ? {tool: 'mcp__wallet__swap', args: {fromToken: c.args.fromToken, toToken: c.args.toToken, ...(c.args.amount ? {amount: c.args.amount} : {}), ...(c.args.slippageBps !== undefined ? {slippageBps: c.args.slippageBps} : {})}} : c;
const mockPlan = spec.mockPlan ? {...spec.mockPlan, calls: spec.mockPlan.calls.map(mapMockCall),
  requiredFinancialActions: spec.mockPlan.requiredFinancialActions?.map(mapMockCall)} : null;

let budgetExhausted = false, logOffset = 0;
const turns: any[] = [];
async function send(text: string, turn: number, turnKind: string) {
  await control('/control/turn', {episodeId: spec.id, turn, turnKind, mockPlan: mockPlan ?? undefined, resetMock: turn === 0, forbidden: spec.forbidden});
  gateBeginTurn(gateFile, turn, text);
  const nonceBefore = await nonce(), started = Date.now();
  let error: string | null = null, responseText: string | null = null, exitCode: number | null = null, stderr = '';
  const events: any[] = [];
  try {
    const proc = Bun.spawn(cliArgs(turn), {cwd: dirs.cwd, env: cliEnv, stdin: new Blob([text]), stdout: 'pipe', stderr: 'pipe'});
    const timeout = setTimeout(() => proc.kill(), 20 * 60 * 1000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    exitCode = await proc.exited;
    clearTimeout(timeout);
    stderr = err.slice(-4000);
    for (const line of out.split('\n')) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch { events.push({type: 'unparsed', line: line.slice(0, 500)}); } }
    const result = events.findLast((e: any) => e.type === 'result');
    if (!result) error = `claude exited ${exitCode} without a result: ${stderr.split('\n').filter(Boolean).at(-1) ?? ''}`.slice(0, 300);
    else if (result.subtype === 'success' && !result.is_error) responseText = String(result.result ?? '');
    else error = `claude result ${result.subtype}: ${String(result.result ?? result.api_error_status ?? '').slice(0, 250)}`;
  } catch (e) { error = errText(e); }
  if (error) {
    const l: any = await (await realFetch(spec.llmUrl + '/control/ledger')).json().catch(() => null);
    if (l?.budgetRefusals > 0) budgetExhausted = true;
  }
  await control('/control/idle');
  // Tool calls and results as the MCP server recorded them (the gate key included), in call order.
  const logText = readFileSync(logPath, 'utf8');
  const logged = logText.slice(logOffset).split('\n').filter(Boolean).map(l => JSON.parse(l));
  logOffset = logText.length;
  const actionResults = logged.map((r: any) => ({tool: r.tool, args: r.args, success: r.success, text: r.data?.preview ?? null, error: r.error,
    requiresConfirmation: r.requiresConfirmation, data: r.data, values: null, gateKey: r.gateKey, mcpTurn: r.turn}));
  const assistant = events.filter((e: any) => e.type === 'assistant');
  const toolCalls = assistant.flatMap((e: any) => (e.message?.content ?? []).filter((c: any) => c.type === 'tool_use').map((c: any) => ({id: c.id, name: c.name, args: c.input})));
  const init = events.find((e: any) => e.type === 'system' && e.subtype === 'init');
  const result = events.findLast((e: any) => e.type === 'result');
  const record = {turn, turnKind, text, startedAt: started, ms: Date.now() - started, error, newTransactions: (await nonce()) - nonceBefore,
    didRespond: responseText !== null, requestFulfilled: null, outcome: null, responseText,
    modelCalls: new Set(assistant.map((e: any) => e.message?.id)).size, toolCalls, actionResults, callbacks: [] as any[],
    cli: {exitCode, sessionId: init?.session_id ?? result?.session_id ?? null, tools: init?.tools ?? null,
      mcpServers: init?.mcp_servers ?? null, model: init?.model ?? null, permissionMode: init?.permissionMode ?? null,
      numTurns: result?.num_turns ?? null, permissionDenials: result?.permission_denials ?? null, terminalReason: result?.terminal_reason ?? null,
      apiErrorStatus: result?.api_error_status ?? null, retries: events.filter((e: any) => e.type === 'system' && /retry/i.test(String(e.subtype))).length,
      stderrTail: stderr ? stderr.slice(-1000) : ''}};
  turns.push(record);
  return record;
}

// Turn loop and closing parse: identical to episode-child-v2.ts and agent2-child.ts (protocol v2-elizaos-3).
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
// Claude Code's own session record (the full conversation as the CLI kept it), with the private folder names removed.
let transcript: any[] = [];
try {
  const proj = join(dirs.cfg, 'projects');
  for (const d of existsSync(proj) ? readdirSync(proj) : []) {
    const f = join(proj, d, `${sessionId}.jsonl`);
    if (existsSync(f)) transcript = readFileSync(f, 'utf8').split(base).join('<work>').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
} catch {}
rmSync(base, {recursive: true, force: true}); // the wallet config holds the fork key
writeFileSync(outPath, JSON.stringify({agent: 'claudecode', termination, declared, turns, events: [], blockedHosts: blocked, tools: ALLOWED,
  claudeVersion, systemPromptSha256: createHash('sha256').update(promptTemplate).digest('hex'), sandbox: 'sandbox-exec: outbound network to localhost only',
  transcript}, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2).split(base).join('<work>'));
process.exit(0);
