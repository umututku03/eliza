// MCP wallet server: the four agent2 wallet tools (get_balances, quote_swap, swap, tx_status) over stdio MCP, so a
// production agent harness (Claude Code: claudecode-child.ts) can be benchmarked with the same tools, the same
// chain calls and the same confirmation gate as agent2. The implementation is wallet-tools.ts, shared with agent2.
//
// Usage: bun research/agent-harness-v2/mcp-wallet-server.ts --config=<config.json>   (or WALLET_MCP_CONFIG=<file>)
// config.json: {rpcUrl, privateKey, wallet?, router, weth, tokens: [address, ...], gateFile, logPath}
//   rpcUrl    the fork RPC fault proxy, the only chain endpoint
//   tokens    get_balances' default token list (the task's X and Y)
//   gateFile  the confirmation-gate state the harness writes before each user turn (wallet-tools.ts gateBeginTurn):
//             an MCP server never sees user turns, so the harness tells it the turn number and whether the user said
//             yes. A swap previewed in an earlier turn is submitted only when the current turn's message is a yes.
//   logPath   JSONL: one line per tool call with its arguments and full result (gateKey included), for the harness
// The config holds the fork test key; the harness writes it to a private temp folder and deletes it after the episode.
// Network guard: only 127.0.0.1 is reachable, as in the episode children. Tool calls run one at a time, as agent2's do.
import {appendFileSync, readFileSync} from 'node:fs';

const cfgPath = process.argv.find(a => a.startsWith('--config='))?.slice(9) ?? process.env.WALLET_MCP_CONFIG;
if (!cfgPath) throw new Error('Pass --config=<file> or WALLET_MCP_CONFIG');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
for (const k of ['rpcUrl', 'privateKey', 'router', 'weth', 'tokens', 'gateFile', 'logPath']) if (!cfg[k]) throw new Error(`config needs ${k}`);
for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MAINNET_FORK_RPC_URL']) delete process.env[k];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new TypeError(`network unavailable: ${url.hostname}`);
  return realFetch(input, init);
}) as any;

const {createWalletTools, TOOLS, errText, modelText, gateLoad, gateSave} = await import('./wallet-tools.ts');
type ToolResult = import('./wallet-tools.ts').ToolResult;
const {Server} = await import('@modelcontextprotocol/sdk/server/index.js');
const {StdioServerTransport} = await import('@modelcontextprotocol/sdk/server/stdio.js');
const {ListToolsRequestSchema, CallToolRequestSchema} = await import('@modelcontextprotocol/sdk/types.js');

const wallet = createWalletTools({rpcUrl: cfg.rpcUrl, privateKey: cfg.privateKey, wallet: cfg.wallet, router: cfg.router, weth: cfg.weth, defaultTokens: cfg.tokens});
const json = (v: any) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));

const server = new Server({name: 'wallet', version: '1.0.0'}, {capabilities: {tools: {}}});
// The MCP tool definitions are agent2's function definitions with the same names, descriptions and JSON schemas.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({name: t.function.name, description: t.function.description, inputSchema: t.function.parameters})),
}));
let queue: Promise<unknown> = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, (req: any) => {
  const run = queue.then(async () => {
    const name = String(req.params.name), args = req.params.arguments ?? {};
    const gate = gateLoad(cfg.gateFile);
    wallet.pending.clear();
    for (const [k, v] of Object.entries(gate.pending)) wallet.pending.set(k, v);
    const started = Date.now();
    let res: ToolResult;
    try { res = await wallet.runTool(name, args, gate.turn, gate.affirmed); }
    catch (e) { res = {success: false, data: null, error: errText(e)}; }
    gateSave(cfg.gateFile, {...gate, pending: Object.fromEntries(wallet.pending)});
    appendFileSync(cfg.logPath, json({at: new Date(started).toISOString(), ms: Date.now() - started, turn: gate.turn, affirmed: gate.affirmed,
      tool: name, args, success: res.success, requiresConfirmation: res.requiresConfirmation === true, error: res.error ?? null,
      data: res.data, gateKey: res.gateKey ?? null}) + '\n');
    return {content: [{type: 'text', text: modelText(res)}]};
  });
  queue = run.catch(() => {});
  return run;
});
await server.connect(new StdioServerTransport());
