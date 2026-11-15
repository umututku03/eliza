// agent2: a second agent for the same benchmark, with no agent framework. One episode in its own process: a plain
// OpenAI-compatible function-calling loop over four wallet tools (get_balances, quote_swap, swap, tx_status) that
// talk to the Uniswap V2 router with viem through the given RPC URL. It honours episode-child-v2.ts's contract
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

const {createPublicClient, createWalletClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, isAddress, parseAbi, parseUnits} = await import('viem');
const {privateKeyToAccount} = await import('viem/accounts');
const {mainnet} = await import('viem/chains');
type Address = `0x${string}`;

if (spec.model.provider !== 'openai') throw new Error('agent2 speaks the OpenAI Chat Completions format only');
const MODEL = spec.model.model;
const CHAT_URL = `${spec.llmUrl}/openai/v1/chat/completions`;
const ROUTER = getAddress(spec.router), WETH = getAddress(spec.weth);
const account = privateKeyToAccount(spec.privateKey);
const WALLET = getAddress(spec.wallet ?? account.address);
const transport = http(spec.forkProxyUrl, {retryCount: 0});
const pub = createPublicClient({chain: mainnet, transport});
const signer = createWalletClient({chain: mainnet, transport, account});
const RECEIPT_TIMEOUT_MS = 60_000; // plugin-wallet's TX_CONFIRMATION_TIMEOUT_MS, so both agents wait the same
const MAX_STEPS = 12;              // model calls per user turn
const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
]);

async function control(path: string, body?: any) {
  const r = await realFetch(spec.llmUrl + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body ?? {})});
  return r.json();
}
async function nonce() {
  const r: any = await (await realFetch(spec.forkProxyUrl, {method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [spec.sender, 'latest']})})).json();
  return Number(r.result);
}
const errText = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 300);

// ---- tools ---------------------------------------------------------------------------------------------------
const NATIVE = 'ETH';
const tokenInfo = new Map<string, {symbol: string; decimals: number}>();
async function token(t: string): Promise<{address: Address | 'ETH'; symbol: string; decimals: number}> {
  const s = String(t ?? '').trim();
  if (/^(eth|native)$/i.test(s) || /^0x0{40}$/i.test(s) || /^0xe{40}$/i.test(s)) return {address: NATIVE, symbol: 'ETH', decimals: 18};
  if (!isAddress(s)) throw new Error(`Unknown token "${s}": give a token contract address, or ETH for native ether.`);
  const a = getAddress(s);
  if (!tokenInfo.has(a)) {
    const [symbol, decimals] = await Promise.all([
      pub.readContract({address: a, abi: ERC20_ABI, functionName: 'symbol'}).catch(() => '?'),
      pub.readContract({address: a, abi: ERC20_ABI, functionName: 'decimals'}),
    ]);
    tokenInfo.set(a, {symbol: String(symbol), decimals: Number(decimals)});
  }
  return {address: a, ...tokenInfo.get(a)!};
}
/** Uniswap V2 route as plugin-wallet's on-chain route builds it: through WETH unless one side is ETH/WETH. */
async function route(args: any) {
  const from = await token(args.fromToken), to = await token(args.toToken);
  const amount = String(args.amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error(`Invalid amount "${args.amount}": give a positive decimal number of ${from.symbol}.`);
  const amountIn = parseUnits(amount, from.decimals);
  const a = from.address === NATIVE ? WETH : from.address, b = to.address === NATIVE ? WETH : to.address;
  if (a === b) throw new Error('fromToken and toToken are the same asset.');
  const path = (a === WETH || b === WETH ? [a, b] : [a, WETH, b]) as Address[];
  const amounts = await pub.readContract({address: ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path]});
  return {from, to, amountIn, amount: formatUnits(amountIn, from.decimals), path, amountOut: amounts[amounts.length - 1]};
}
/** Polls for the receipt once a second for up to 60 s; null if none appeared. A plain poll: viem's
 *  waitForTransactionReceipt throws at once when a mined transaction's receipt is missing. */
async function waitReceipt(hash: `0x${string}`) {
  for (const until = Date.now() + RECEIPT_TIMEOUT_MS; Date.now() < until; await Bun.sleep(1000)) {
    const r = await pub.getTransactionReceipt({hash}).catch((e: any) => { if (e?.name === 'TransactionReceiptNotFoundError') return null; throw e; });
    if (r) return r;
  }
  return null;
}

// Confirmation gate, like plugin-wallet's: a swap is first a proposal keyed by its parameters; it is submitted only
// when the same swap is requested again after the user's next message is a yes. Any other user message cancels it.
const pending = new Map<string, number>();
const swapKey = (r: Awaited<ReturnType<typeof route>>, slip: number) => `${r.from.address}|${r.to.address}|${r.amountIn}|${slip}`;
const AFFIRM = /^\s*(yes|y|yep|confirm(ed)?|approve(d)?|go ahead|ok(ay)?)\b/i;

const TOOLS = [
  {type: 'function', function: {name: 'get_balances', description: 'Read the wallet\'s ETH balance and the balances of the given ERC-20 tokens.',
    parameters: {type: 'object', properties: {tokens: {type: 'array', items: {type: 'string'}, description: 'ERC-20 token contract addresses.'}}, required: []}}},
  {type: 'function', function: {name: 'quote_swap', description: 'Quote a Uniswap V2 swap on Ethereum mainnet without executing it.',
    parameters: {type: 'object', properties: {fromToken: {type: 'string', description: 'Token contract address, or ETH.'},
      toToken: {type: 'string', description: 'Token contract address, or ETH.'}, amount: {type: 'string', description: 'Exact input amount in decimal units of fromToken.'}},
      required: ['fromToken', 'toToken', 'amount']}}},
  {type: 'function', function: {name: 'swap', description: 'Swap an exact input amount on Uniswap V2 on Ethereum mainnet. The first call returns a preview and asks the user to confirm; after the user replies yes, call swap again with the same parameters to submit the transaction.',
    parameters: {type: 'object', properties: {fromToken: {type: 'string', description: 'Token contract address, or ETH.'},
      toToken: {type: 'string', description: 'Token contract address, or ETH.'}, amount: {type: 'string', description: 'Exact input amount in decimal units of fromToken.'},
      slippageBps: {type: 'integer', description: 'Maximum slippage in basis points (default 100).'}},
      required: ['fromToken', 'toToken', 'amount']}}},
  {type: 'function', function: {name: 'tx_status', description: 'Look up a transaction by hash: its receipt status and block, or whether it is pending or unknown.',
    parameters: {type: 'object', properties: {hash: {type: 'string', description: 'Transaction hash.'}}, required: ['hash']}}},
];
// Workflow tasks (WS-W, run-v2 spec.workflow) add one tool each; swap2 tasks keep exactly the four tools above.
//   approve_swap (A1): approve_token, an exact ERC-20 approval.  supply (L1): aave_supply, Pool.supply on the wallet's behalf.
// Both sit behind the same preview/confirm gate as swap.
const POOL = spec.pool ? getAddress(spec.pool) : null;
const POOL_ABI = parseAbi(['function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)']);
if (spec.workflow === 'approve_swap') TOOLS.push({type: 'function', function: {name: 'approve_token', description: 'Approve a spender (for example a DEX router) to spend an exact amount of an ERC-20 token from the wallet. The first call returns a preview and asks the user to confirm; after the user replies yes, call approve_token again with the same parameters to submit the transaction.',
  parameters: {type: 'object', properties: {token: {type: 'string', description: 'ERC-20 token contract address.'}, spender: {type: 'string', description: 'Spender contract address.'},
    amount: {type: 'string', description: 'Exact allowance in decimal units of the token.'}}, required: ['token', 'spender', 'amount']}}} as any);
if (spec.workflow === 'supply') TOOLS.push({type: 'function', function: {name: 'aave_supply', description: `Supply an exact amount of an ERC-20 token to the Aave v3 pool ${POOL} on Ethereum mainnet on behalf of the wallet (approving the pool for that amount first if needed); the wallet receives the aToken. The first call returns a preview and asks the user to confirm; after the user replies yes, call aave_supply again with the same parameters to submit.`,
  parameters: {type: 'object', properties: {token: {type: 'string', description: 'ERC-20 token contract address.'},
    amount: {type: 'string', description: 'Exact amount in decimal units of the token.'}}, required: ['token', 'amount']}}} as any);
const TOOL_NAMES = TOOLS.map(t => t.function.name);

// gateKey (swap only) is recorded for the audit and never shown to the model.
type ToolResult = {success: boolean; requiresConfirmation?: boolean; data: any; error?: string | null; gateKey?: string};
async function runTool(name: string, args: any, turn: number, affirmed: boolean): Promise<ToolResult> {
  if (name === 'get_balances') {
    const list = Array.isArray(args.tokens) && args.tokens.length ? args.tokens : [spec.x.address, spec.y.address];
    const out: any = {wallet: WALLET, ETH: formatEther(await pub.getBalance({address: WALLET}))};
    for (const t of list) {
      const k = await token(t);
      if (k.address === NATIVE) continue;
      const bal = await pub.readContract({address: k.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET]});
      out[k.address] = {symbol: k.symbol, balance: formatUnits(bal, k.decimals)};
    }
    return {success: true, data: out};
  }
  if (name === 'quote_swap') {
    const r = await route(args);
    return {success: true, data: {fromToken: r.from.symbol, toToken: r.to.symbol, amountIn: r.amount, expectedOut: formatUnits(r.amountOut, r.to.decimals), path: r.path}};
  }
  if (name === 'tx_status') {
    const hash = String(args.hash ?? '').trim() as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid transaction hash.');
    const head = Number(await pub.getBlockNumber());
    const r = await pub.getTransactionReceipt({hash}).catch(() => null);
    if (r) return {success: true, data: {hash, status: r.status, block: Number(r.blockNumber), confirmations: head - Number(r.blockNumber) + 1, latestBlock: head}};
    const tx = await pub.getTransaction({hash}).catch(() => null);
    return {success: true, data: {hash, status: tx ? 'pending' : 'not_found', latestBlock: head}};
  }
  if (name === 'approve_token' && spec.workflow === 'approve_swap') {
    const k = await token(args.token);
    if (k.address === NATIVE) throw new Error('Native ETH needs no approval.');
    if (!isAddress(String(args.spender ?? ''))) throw new Error('Invalid spender: give a contract address.');
    const spender = getAddress(String(args.spender)), amountIn = amountOf(args.amount, k);
    const key = `approve|${k.address}|${spender}|${amountIn}`;
    if (!(affirmed && pending.has(key) && pending.get(key)! < turn)) {
      pending.set(key, turn);
      const current = await pub.readContract({address: k.address, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, spender]});
      const preview = `Approve ${spender} to spend exactly ${formatUnits(amountIn, k.decimals)} ${k.symbol} from ${WALLET} (current allowance ${formatUnits(current, k.decimals)})? Reply yes to submit or no to cancel.`;
      return {success: true, requiresConfirmation: true, data: {status: 'awaiting_confirmation', preview}, gateKey: key};
    }
    pending.delete(key);
    try {
      const hash = await signer.writeContract({address: k.address, abi: ERC20_ABI, functionName: 'approve', args: [spender, amountIn]});
      return {...await settled(hash, {allowance: `${formatUnits(amountIn, k.decimals)} ${k.symbol}`, spender}, 'Approval'), gateKey: key};
    } catch (e) { return {success: false, data: {status: 'failed'}, error: errText(e), gateKey: key}; }
  }
  if (name === 'aave_supply' && spec.workflow === 'supply') {
    const k = await token(args.token);
    if (k.address === NATIVE) throw new Error('Give an ERC-20 token address; native ETH cannot be supplied with this tool.');
    const amountIn = amountOf(args.amount, k);
    const key = `supply|${k.address}|${amountIn}`;
    if (!(affirmed && pending.has(key) && pending.get(key)! < turn)) {
      pending.set(key, turn);
      const preview = `Supply ${formatUnits(amountIn, k.decimals)} ${k.symbol} to the Aave v3 pool ${POOL} on behalf of ${WALLET}? Reply yes to submit or no to cancel.`;
      return {success: true, requiresConfirmation: true, data: {status: 'awaiting_confirmation', preview}, gateKey: key};
    }
    pending.delete(key);
    try { return {...await submitSupply(k, amountIn), gateKey: key}; }
    catch (e) { return {success: false, data: {status: 'failed'}, error: errText(e), gateKey: key}; }
  }
  if (name === 'swap') {
    const slip = args.slippageBps === undefined || args.slippageBps === null ? 100 : Number(args.slippageBps);
    if (!Number.isInteger(slip) || slip < 0 || slip >= 10000) throw new Error('slippageBps must be an integer from 0 to 9999.');
    const r = await route(args);
    const key = swapKey(r, slip);
    if (!(affirmed && pending.has(key) && pending.get(key)! < turn)) {
      pending.set(key, turn);
      const preview = `Swap ${r.amount} ${r.from.symbol} to ${r.to.symbol} on Ethereum mainnet (expected ${formatUnits(r.amountOut, r.to.decimals)} ${r.to.symbol}, max slippage ${slip / 100}%)? Reply yes to submit or no to cancel.`;
      return {success: true, requiresConfirmation: true, data: {status: 'awaiting_confirmation', preview}, gateKey: key};
    }
    pending.delete(key);
    try { return {...await submitSwap(r, slip), gateKey: key}; }
    catch (e) { return {success: false, data: {status: 'failed'}, error: errText(e), gateKey: key}; }
  }
  throw new Error(`Unknown tool ${name}`);
}
function amountOf(raw: any, k: {symbol: string; decimals: number}) {
  const amount = String(raw ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) throw new Error(`Invalid amount "${raw}": give a positive decimal number of ${k.symbol}.`);
  return parseUnits(amount, k.decimals);
}
/** Waits for a submitted transaction like submitSwap does: success, reverted, or submitted without a receipt yet. */
async function settled(hash: `0x${string}`, base: any, what: string): Promise<ToolResult> {
  const rc = await waitReceipt(hash);
  if (!rc) return {success: true, data: {hash, ...base, status: 'submitted', note: `No receipt after ${RECEIPT_TIMEOUT_MS / 1000} s; check it with tx_status.`}};
  if (rc.status !== 'success') return {success: false, data: {hash, ...base, status: 'reverted', block: Number(rc.blockNumber)}, error: `${what} transaction ${hash} reverted.`};
  return {success: true, data: {hash, ...base, status: 'success', block: Number(rc.blockNumber)}};
}
/** The confirmed supply: exact approval of the pool if the allowance is short (waited on), then Pool.supply. */
async function submitSupply(k: {address: Address | 'ETH'; symbol: string; decimals: number}, amountIn: bigint): Promise<ToolResult> {
  const t = k.address as Address;
  let approval: any = null;
  const allowance = await pub.readContract({address: t, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, POOL!]});
  if (allowance < amountIn) {
    const ah = await signer.writeContract({address: t, abi: ERC20_ABI, functionName: 'approve', args: [POOL!, amountIn]});
    const ar = await waitReceipt(ah);
    approval = {hash: ah, status: ar ? ar.status : 'no_receipt_yet'};
    if (!ar || ar.status !== 'success') return {success: false, data: {status: 'approval_not_confirmed', approval}, error: `Token approval ${ah} not confirmed (${approval.status}).`};
  }
  const hash = await signer.writeContract({address: POOL!, abi: POOL_ABI, functionName: 'supply', args: [t, amountIn, WALLET, 0]});
  return settled(hash, {approval, amount: `${formatUnits(amountIn, k.decimals)} ${k.symbol}`, onBehalfOf: WALLET}, 'Supply');
}
/** The confirmed swap: approval if needed, then the router call, each waited on like plugin-wallet does. */
async function submitSwap(r: Awaited<ReturnType<typeof route>>, slip: number): Promise<ToolResult> {
  const minOut = (r.amountOut * BigInt(10000 - slip)) / 10000n;
  const deadline = (await pub.getBlock()).timestamp + 1200n; // chain time, as plugin-wallet does
  let approval: any = null;
  if (r.from.address !== NATIVE) {
    const allowance = await pub.readContract({address: r.from.address, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, ROUTER]});
    if (allowance < r.amountIn) {
      const ah = await signer.writeContract({address: r.from.address, abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, r.amountIn]});
      const ar = await waitReceipt(ah);
      approval = {hash: ah, status: ar ? ar.status : 'no_receipt_yet'};
      if (!ar || ar.status !== 'success') return {success: false, data: {status: 'approval_not_confirmed', approval}, error: `Token approval ${ah} not confirmed (${approval.status}).`};
    }
  }
  const data = r.from.address === NATIVE
    ? encodeFunctionData({abi: ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [minOut, r.path, WALLET, deadline]})
    : encodeFunctionData({abi: ROUTER_ABI, functionName: r.to.address === NATIVE ? 'swapExactTokensForETH' : 'swapExactTokensForTokens', args: [r.amountIn, minOut, r.path, WALLET, deadline]});
  const hash = await signer.sendTransaction({to: ROUTER, value: r.from.address === NATIVE ? r.amountIn : 0n, data});
  const rc = await waitReceipt(hash);
  const base = {hash, approval, amountIn: `${r.amount} ${r.from.symbol}`, minOut: `${formatUnits(minOut, r.to.decimals)} ${r.to.symbol}`};
  if (!rc) return {success: true, data: {...base, status: 'submitted', note: `No receipt after ${RECEIPT_TIMEOUT_MS / 1000} s; check it with tx_status.`}};
  if (rc.status !== 'success') return {success: false, data: {...base, status: 'reverted', block: Number(rc.blockNumber)}, error: `Swap transaction ${hash} reverted.`};
  return {success: true, data: {...base, status: 'success', block: Number(rc.blockNumber)}};
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
const mockPlan = spec.mockPlan ? {...spec.mockPlan, calls: spec.mockPlan.calls.map((c: any) => c.tool === 'WALLET_SWAP'
  ? {tool: 'swap', args: {fromToken: c.args.fromToken, toToken: c.args.toToken, amount: c.args.amount, slippageBps: c.args.slippageBps}} : c)} : null;

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
        messages.push({role: 'tool', tool_call_id: c.id, content: JSON.stringify(res.error ? {error: res.error, ...(res.data ? {data: res.data} : {})} : res.data)});
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
