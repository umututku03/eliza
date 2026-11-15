// The four wallet tools (get_balances, quote_swap, swap, tx_status) and their confirmation gate, shared by agent2
// (agent2-child.ts, OpenAI function calling) and the MCP wallet server (mcp-wallet-server.ts, used by Claude Code).
// Moved out of agent2-child.ts unchanged: the same viem calls against the given RPC URL (the fork fault proxy), the
// same Uniswap V2 route as plugin-wallet's on-chain route, the same 60 s receipt poll and the same gate.
// See AGENT-INTERFACE.md ("agent2") for the tool contract.
import {createPublicClient, createWalletClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, isAddress, parseAbi, parseUnits} from 'viem';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet} from 'viem/chains';
type Address = `0x${string}`;

export const errText = (e: any) => String(e?.shortMessage ?? e?.message ?? e).split('\n')[0].slice(0, 300);
/** A user message that approves a pending preview (plugin-wallet's gate accepts the same openings). */
export const AFFIRM = /^\s*(yes|y|yep|confirm(ed)?|approve(d)?|go ahead|ok(ay)?)\b/i;

export const TOOLS = [
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
export const TOOL_NAMES = TOOLS.map(t => t.function.name);

// gateKey (swap only) is recorded for the audit and never shown to the model.
export type ToolResult = {success: boolean; requiresConfirmation?: boolean; data: any; error?: string | null; gateKey?: string};
/** What the model sees for a tool result (agent2's tool message content; the MCP server's text content). */
export const modelText = (res: ToolResult) => JSON.stringify(res.error ? {error: res.error, ...(res.data ? {data: res.data} : {})} : res.data);

export type WalletConfig = {rpcUrl: string; privateKey: `0x${string}`; wallet?: string; router: string; weth: string; defaultTokens: string[]};

export function createWalletTools(cfg: WalletConfig) {
  const ROUTER = getAddress(cfg.router), WETH = getAddress(cfg.weth);
  const account = privateKeyToAccount(cfg.privateKey);
  const WALLET = getAddress(cfg.wallet ?? account.address);
  const transport = http(cfg.rpcUrl, {retryCount: 0});
  const pub = createPublicClient({chain: mainnet, transport});
  const signer = createWalletClient({chain: mainnet, transport, account});
  const RECEIPT_TIMEOUT_MS = 60_000; // plugin-wallet's TX_CONFIRMATION_TIMEOUT_MS, so both agents wait the same
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
  // `pending` maps a gate key to the turn of its preview; the caller clears it on a user message that is not a yes.
  const pending = new Map<string, number>();
  const swapKey = (r: Awaited<ReturnType<typeof route>>, slip: number) => `${r.from.address}|${r.to.address}|${r.amountIn}|${slip}`;

  async function runTool(name: string, args: any, turn: number, affirmed: boolean): Promise<ToolResult> {
    if (name === 'get_balances') {
      const list = Array.isArray(args.tokens) && args.tokens.length ? args.tokens : cfg.defaultTokens;
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

  return {WALLET, account, pending, runTool};
}

// ---- gate state across processes (MCP wallet server) ------------------------------------------------------------
// An MCP server never sees the user's messages, and Claude Code starts a fresh server process for each headless
// `claude -p` run (one per user turn). The gate's inputs therefore live in a small JSON file owned by the harness:
// before each user turn the harness calls gateBeginTurn (turn number, whether the message is a yes); the server
// loads `pending` from it before every tool call and saves it after. With one writer at a time (the harness between
// turns, the server's serialized tool calls during a turn) this is agent2's in-memory gate, step for step.
export type GateState = {turn: number; affirmed: boolean; pending: Record<string, number>};
export function gateLoad(path: string): GateState {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {turn: -1, affirmed: false, pending: {}};
}
export function gateSave(path: string, s: GateState) { writeFileSync(path, JSON.stringify(s)); }
/** The user's message for `turn`: as agent2's send(), a message that is not a yes cancels every pending preview. */
export function gateBeginTurn(path: string, turn: number, text: string): GateState {
  const s = gateLoad(path), affirmed = AFFIRM.test(text);
  const next = {turn, affirmed, pending: affirmed ? s.pending : {}};
  gateSave(path, next);
  return next;
}
