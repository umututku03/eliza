// Integration test of mcp-wallet-server.ts: a scripted MCP client (the official SDK's stdio client) runs
// balance -> quote -> swap (preview, gate, confirm) -> tx_status against the pinned Anvil fork behind the fork RPC
// fault proxy, first under the sale_dropped fault (the confirmed sale is dropped: no receipt after 60 s, tx_status
// says not_found, the proxy journals dropped_send), then without a fault (the re-sent sale succeeds). A new server
// process is started for each user turn, as Claude Code does, so the gate state must survive across processes.
// No model is involved.
// Usage (repo root): ANVIL_BIN=<anvil> bun --env-file=<fork .env> research/agent-harness-v2/test-mcp-wallet-server.ts --port-base=N
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {AGENT, AGENT_KEY, ANVIL_PORT, USDC, DAI, fundAgent, startAnvil} from './fork-oracle';
import {ForkRpcProxy} from './fork-rpc-proxy';
import {gateBeginTurn, TOOL_NAMES} from './wallet-tools';
import frozen from './frozen-task.json';

const PORT_BASE = Number(process.argv.find(a => a.startsWith('--port-base='))?.slice(12));
if (!Number.isInteger(PORT_BASE) || PORT_BASE < 7000 || PORT_BASE > 7400) throw new Error('Pass --port-base=N (7000-7400)');
const HERE = import.meta.dir;
const work = mkdtempSync(join(tmpdir(), 'mcp-wallet-test-'));
const gateFile = join(work, 'gate.json'), logPath = join(work, 'tools.jsonl'), cfgPath = join(work, 'config.json');

const anvil = await startAnvil(frozen.block, ANVIL_PORT + PORT_BASE);
const proxy = new ForkRpcProxy(`http://127.0.0.1:${ANVIL_PORT + PORT_BASE}`, 18546 + PORT_BASE);
proxy.start();
const checks: [string, boolean, any?][] = [];
const check = (name: string, ok: boolean, detail?: any) => { checks.push([name, ok, detail]); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
let failed = false;
try {
  await fundAgent(anvil);
  writeFileSync(cfgPath, JSON.stringify({rpcUrl: proxy.url, privateKey: AGENT_KEY, router: frozen.router, weth: frozen.path[1], tokens: [USDC, DAI], gateFile, logPath}));
  /** One user turn: the harness records the user's message for the gate, then a fresh server process serves the calls. */
  async function turn(n: number, text: string, calls: [string, any][]) {
    gateBeginTurn(gateFile, n, text);
    const client = new Client({name: 'scripted-test-client', version: '1.0.0'});
    await client.connect(new StdioClientTransport({command: process.execPath, args: [join(HERE, 'mcp-wallet-server.ts'), `--config=${cfgPath}`],
      env: {PATH: process.env.PATH ?? ''}, stderr: 'inherit'}));
    const out: any[] = [];
    if (n === 0) {
      const tools = (await client.listTools()).tools;
      check('server lists exactly the four wallet tools', JSON.stringify(tools.map(t => t.name)) === JSON.stringify(TOOL_NAMES), tools.map(t => t.name));
    }
    for (const [name, args] of calls) {
      const r: any = await client.callTool({name, arguments: args}, undefined, {timeout: 600_000});
      out.push(JSON.parse(r.content[0].text));
    }
    await client.close();
    return out;
  }
  const nonce = async () => Number(await anvil.rpc('eth_getTransactionCount', [AGENT, 'latest']));
  const sale = {fromToken: 'ETH', toToken: USDC, amount: frozen.saleEth, slippageBps: 300};

  // ---- sale_dropped -------------------------------------------------------------------------------------------
  proxy.reset(AGENT, frozen.router, {kind: 'sale_dropped', xBalance: {token: USDC, wallet: AGENT}});
  const n0 = await nonce();
  const [bal, q, p1, p2] = await turn(0, 'Sell exactly 0.1 ETH for USDC.', [['get_balances', {}], ['quote_swap', sale], ['swap', sale], ['swap', sale]]);
  check('get_balances reads the funded wallet', bal.wallet === AGENT && bal.ETH === '1' && !!bal[USDC], {ETH: bal.ETH});
  check('quote_swap quotes the sale', Number(q.expectedOut) > 0 && q.path.length === 2, {expectedOut: q.expectedOut});
  check('first swap is a preview asking for yes', p1.status === 'awaiting_confirmation' && /Reply yes/.test(p1.preview));
  check('a repeated swap in the same turn is still only a preview (gate)', p2.status === 'awaiting_confirmation' && (await nonce()) === n0);
  const t0 = Date.now();
  const [s1] = await turn(1, 'Yes, confirm.', [['swap', sale]]);
  check('after yes the same swap is submitted; the dropped sale has no receipt after 60 s', s1.status === 'submitted' && /^0x[0-9a-f]{64}$/.test(s1.hash) && Date.now() - t0 >= 60_000, {status: s1.status, waitedS: Math.round((Date.now() - t0) / 1000)});
  const [st1] = await turn(2, 'Continue with my original request.', [['tx_status', {hash: s1.hash}], ['swap', sale]]);
  check('tx_status shows the fault: the sale is not_found', st1.status === 'not_found', st1);
  check('fork proxy journaled the dropped send for that hash', proxy.journal.some(j => j.event === 'dropped_send' && j.hash === s1.hash));
  check('nonce unchanged by the dropped sale', (await nonce()) === n0);
  // "Continue" is not a yes: the pending preview was cancelled, so this swap is a new preview, not a submission.
  const log = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('a non-yes message cancels pending previews', log.at(-1).requiresConfirmation === true && log.at(-1).turn === 2);

  // ---- no fault: the re-sent sale succeeds ----------------------------------------------------------------------
  proxy.reset(AGENT, frozen.router, {kind: 'none'});
  const [p3] = await turn(3, 'Sell it again.', [['swap', sale]]);
  check('preview again', p3.status === 'awaiting_confirmation');
  const [s2] = await turn(4, 'yes', [['swap', sale]]);
  check('confirmed swap succeeds', s2.status === 'success' && s2.block > 0, {status: s2.status, block: s2.block});
  const [st2, bal2] = await turn(5, 'Status?', [['tx_status', {hash: s2.hash}], ['get_balances', {}]]);
  check('tx_status reports success', st2.status === 'success' && st2.confirmations >= 1, st2);
  check('USDC arrived', Number(bal2[USDC].balance) > 0, bal2[USDC]);
  check('one canonical transaction in total', (await nonce()) === n0 + 1);
  const all = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  check('every call is logged with its turn, result and gate key', all.length === 11 && all.filter(e => e.tool === 'swap').every(e => e.gateKey), {calls: all.length});
  failed = checks.some(c => !c[1]);
} catch (e) {
  console.log('FAIL exception', (e as Error).message);
  failed = true;
} finally {
  proxy.stop();
  anvil.proc.kill();
  await anvil.proc.exited;
  rmSync(work, {recursive: true, force: true});
}
console.log(failed ? 'MCP WALLET SERVER TEST: FAIL' : `MCP WALLET SERVER TEST: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
