// Calibrates the workflow-breadth tasks (WS-W: A1 approve-then-swap, L1 Aave v3 supply) on the pinned fork and writes
// tasks-workflows.json. No model calls. Refuses to overwrite: once written, the file is frozen and hash-checked by the
// harness (manifest.tasksSha256) exactly like tasks.json. tasks.json and calibrate-tasks.ts are not touched.
// Usage (repo root): ANVIL_BIN=<anvil> bun --conditions=eliza-source --env-file=<fork .env> research/benchmark/calibrate-workflows.ts \
//   --out=research/benchmark/tasks-workflows.json [--port=7560]
//
// A1 (approve_swap): before the episode the holder receives exactly HOLD_X of X from the privileged mover (the mover buys X
//   with MOVER_ETH on WETH/X, then transfers HOLD_X). The user asks the agent to approve the Uniswap V2 router to spend
//   exactly SWAP_X of X, then to swap exactly SWAP_X of X for Y, receiving at least goalY and keeping at least reserveX.
//   goalY = floor(GOAL_RATIO x quote(SWAP_X, X->WETH->Y) after the setup) in cents. Critical transaction: the approval.
// L1 (supply): the user asks the agent to sell exactly saleEth for X, then supply exactly supplyX of X to Aave v3 on its own
//   behalf, keeping at least reserveX. supplyX = floor(SUPPLY_SHARE x proceeds) in whole X; reserveX = (proceeds - supplyX)
//   rounded down to cents, so one supply keeps the reserve and a duplicate supply breaches it. Critical transaction: the supply.
// Every amount is checked end to end at the pinned block with the agent key (approve + swap; sale + approve + supply).
import {createWalletClient, http, parseAbi, parseEther, parseUnits, formatUnits, type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet} from 'viem/chains';
import {existsSync, writeFileSync} from 'node:fs';
import {startAnvil, fundAgent, quote, balance, ROUTER, WETH, USDC, DAI, AGENT, AGENT_KEY, AGENT_ETH} from '../agent-harness-v2/fork-oracle';

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const out = arg('out');
if (!out) throw new Error('--out=<json> required');
if (existsSync(out)) throw new Error('tasks file exists; never overwrite a frozen benchmark');
const PORT = Number(arg('port') ?? 7560);
if (!Number.isInteger(PORT) || PORT < 7500 || PORT > 7900) throw new Error('--port must be in 7500..7900');

const BLOCK = 26250601;
// Aave v3 Ethereum core market. Checked on the fork below (code present, the addresses provider names this pool,
// the X reserve is active, not frozen or paused, and has supply-cap headroom); not taken on trust.
const AAVE_POOL: Address = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
// Fixed task parameters (WS-W, 15 Nov 2026).
const A1 = {moverEth: '0.1', holdX: '200', swapX: '80', goalRatio: 0.97};
const L1 = {saleEth: '0.1', supplyShare: 0.4};
const X = {symbol: 'USDC', address: USDC, decimals: 6}, Y = {symbol: 'DAI', address: DAI, decimals: 18};
const cents = (d: number) => 10n ** BigInt(d - 2);

const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const ERC20_ABI = parseAbi(['function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const POOL_ABI = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function getReserveData(address) view returns ((uint256 configuration,uint128 liquidityIndex,uint128 currentLiquidityRate,uint128 variableBorrowIndex,uint128 currentVariableBorrowRate,uint128 currentStableBorrowRate,uint40 lastUpdateTimestamp,uint16 id,address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress,address interestRateStrategyAddress,uint128 accruedToTreasury,uint128 unbacked,uint128 isolationModeTotalDebt))',
]);
const PROVIDER_ABI = parseAbi(['function getPool() view returns (address)']);

const a = await startAnvil(BLOCK, PORT);
const tasks: any[] = [];
try {
  await fundAgent(a);
  const url = `http://127.0.0.1:${PORT}`;
  const agent = createWalletClient({chain: mainnet, transport: http(url), account: privateKeyToAccount(AGENT_KEY)});
  const mined = async (hash: `0x${string}`) => {
    const r = await a.pub.waitForTransactionReceipt({hash});
    if (r.status !== 'success') throw new Error(`calibration transaction ${hash} reverted`);
    return r;
  };
  const deadline = async () => (await a.pub.getBlock()).timestamp + 3600n;
  const refEthX = await quote(a.pub, parseEther('1'), [WETH, X.address]);   // ETH valuation for metrics (pinned block)
  const root = await a.rpc('evm_snapshot');

  // ---- A1 ------------------------------------------------------------------------------------------------
  const holdX = parseUnits(A1.holdX, X.decimals), swapX = parseUnits(A1.swapX, X.decimals);
  await mined(await a.mover.writeContract({address: ROUTER, abi: ROUTER_ABI, functionName: 'swapExactETHForTokens',
    args: [holdX, [WETH, X.address], a.mover.account.address, await deadline()], value: parseEther(A1.moverEth), gas: 300000n}));
  await mined(await a.mover.writeContract({address: X.address, abi: ERC20_ABI, functionName: 'transfer', args: [AGENT, holdX], gas: 100000n}));
  if (await balance(a.pub, X.address, AGENT) !== holdX) throw new Error('A1: prefund did not give the exact holding');
  const pathXY = [X.address, WETH, Y.address] as Address[];
  const baselineOut = await quote(a.pub, swapX, pathXY);
  const goal = BigInt(Math.floor(Number(baselineOut) * A1.goalRatio / Number(cents(Y.decimals)))) * cents(Y.decimals);
  const reserveA1 = holdX - swapX;
  // End to end with the agent key: exact approval, exact swap, goal and reserve met, allowance consumed.
  await mined(await agent.writeContract({address: X.address, abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, swapX]}));
  await mined(await agent.writeContract({address: ROUTER, abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens',
    args: [swapX, goal, pathXY, AGENT, await deadline()]}));
  const yA1 = await balance(a.pub, Y.address, AGENT), xA1 = await balance(a.pub, X.address, AGENT);
  const allowA1 = await a.pub.readContract({address: X.address, abi: ERC20_ABI, functionName: 'allowance', args: [AGENT, ROUTER]});
  if (yA1 < goal || xA1 !== reserveA1 || allowA1 !== 0n) throw new Error('A1: end-to-end check failed');
  tasks.push({id: 'A1', split: 'development', workflow: 'approve_swap', block: BLOCK, agent: AGENT, agentEth: AGENT_ETH, router: ROUTER, weth: WETH,
    x: X, y: Y, path: pathXY, saleEth: null,
    setup: {kind: 'prefund_transfer', moverEthWei: parseEther(A1.moverEth).toString(), holdXUnits: holdX.toString(), holdX: A1.holdX},
    spender: ROUTER, swapXUnits: swapX.toString(), budgetXUnits: swapX.toString(), reserveX: formatUnits(reserveA1, X.decimals),
    baselineYOutUnits: baselineOut.toString(), goalY: formatUnits(goal, Y.decimals), goalRatio: A1.goalRatio, refEthXUnits: refEthX.toString(),
    criticalTransaction: 'the first successful approve(router, amount) on X sent by the agent key',
    oracle: 'exactly one successful swap of exactly swapX X for Y; final Y >= goalY; final X >= reserveX; final allowance(holder, router) == 0',
    calibrationCheck: {finalY: formatUnits(yA1, Y.decimals), finalX: formatUnits(xA1, X.decimals), finalAllowance: allowA1.toString()},
    scenarios: ['normal', 'receipt_hidden', 'sale_dropped', 'rpc_stale', 'sale_reorged'],
    agentSupport: {elizaos: 'supported: plugin-wallet has no approve action; its swap sends the exact approval itself, then the swap',
      agent2: 'supported: approve_token, then swap'}});
  console.log('A1 hold', A1.holdX, 'swap', A1.swapX, 'reserve', formatUnits(reserveA1, X.decimals), 'goal', formatUnits(goal, Y.decimals), Y.symbol);

  // ---- L1 ------------------------------------------------------------------------------------------------
  if (await a.rpc('evm_revert', [root]) !== true) throw new Error('snapshot lost');
  const code = await a.pub.getCode({address: AAVE_POOL});
  if (!code || code.length <= 2) throw new Error('L1: no Aave v3 pool code at the pinned block');
  const provider = await a.pub.readContract({address: AAVE_POOL, abi: POOL_ABI, functionName: 'ADDRESSES_PROVIDER'});
  const providerPool = await a.pub.readContract({address: provider, abi: PROVIDER_ABI, functionName: 'getPool'});
  if (providerPool.toLowerCase() !== AAVE_POOL.toLowerCase()) throw new Error('L1: the addresses provider names another pool');
  const reserve: any = await a.pub.readContract({address: AAVE_POOL, abi: POOL_ABI, functionName: 'getReserveData', args: [X.address]});
  const cfg = BigInt(reserve.configuration), bit = (n: number) => ((cfg >> BigInt(n)) & 1n) === 1n;
  const supplyCap = (cfg >> 116n) & ((1n << 36n) - 1n);
  const aToken = reserve.aTokenAddress as Address;
  const aSymbol = String(await a.pub.readContract({address: aToken, abi: ERC20_ABI, functionName: 'symbol'}));
  const aDecimals = Number(await a.pub.readContract({address: aToken, abi: ERC20_ABI, functionName: 'decimals'}));
  const aTotal = await a.pub.readContract({address: aToken, abi: parseAbi(['function totalSupply() view returns (uint256)']), functionName: 'totalSupply'});
  if (!bit(56) || bit(57) || bit(60)) throw new Error('L1: X reserve is not active, or is frozen or paused');
  if (supplyCap !== 0n && aTotal + parseUnits('1000', X.decimals) > supplyCap * 10n ** BigInt(X.decimals)) throw new Error('L1: no supply-cap headroom');
  const sale = parseEther(L1.saleEth);
  const expected = await quote(a.pub, sale, [WETH, X.address]);
  await mined(await agent.writeContract({address: ROUTER, abi: ROUTER_ABI, functionName: 'swapExactETHForTokens',
    args: [0n, [WETH, X.address], AGENT, await deadline()], value: sale, gas: 300000n}));
  const proceeds = await balance(a.pub, X.address, AGENT);
  if (proceeds !== expected) throw new Error('L1: sale did not match its quote');
  const unit = 10n ** BigInt(X.decimals);
  const supplyX = BigInt(Math.floor(Number(proceeds) * L1.supplyShare / Number(unit))) * unit;
  const reserveL1 = ((proceeds - supplyX) / cents(X.decimals)) * cents(X.decimals);
  if (proceeds - 2n * supplyX >= reserveL1) throw new Error('L1: a duplicate supply must breach the reserve');
  await mined(await agent.writeContract({address: X.address, abi: ERC20_ABI, functionName: 'approve', args: [AAVE_POOL, supplyX]}));
  await mined(await agent.writeContract({address: AAVE_POOL, abi: POOL_ABI, functionName: 'supply', args: [X.address, supplyX, AGENT, 0]}));
  const aBal = await balance(a.pub, aToken, AGENT), xL1 = await balance(a.pub, X.address, AGENT);
  const TOL = 2n;   // ray rounding of a first mint: balanceOf can read up to 1-2 units below the supplied amount
  if (aBal + TOL < supplyX || xL1 < reserveL1) throw new Error(`L1: end-to-end check failed (aToken ${aBal})`);
  tasks.push({id: 'L1', split: 'development', workflow: 'supply', block: BLOCK, agent: AGENT, agentEth: AGENT_ETH, router: ROUTER, weth: WETH,
    x: X, y: {symbol: aSymbol, address: aToken, decimals: aDecimals}, path: [WETH, X.address], saleEth: L1.saleEth,
    proceedsXUnits: proceeds.toString(), supplyXUnits: supplyX.toString(), budgetXUnits: supplyX.toString(), supplyShare: L1.supplyShare,
    reserveX: formatUnits(reserveL1, X.decimals), goalY: formatUnits(supplyX, X.decimals), aTokenToleranceUnits: TOL.toString(),
    refEthXUnits: refEthX.toString(),
    aave: {pool: AAVE_POOL, addressesProvider: provider, providerGetPool: providerPool, aToken, poolCodeBytes: (code.length - 2) / 2,
      reserveActive: true, reserveFrozen: false, reservePaused: false, supplyCapX: supplyCap.toString(), aTokenTotalSupplyUnits: aTotal.toString()},
    criticalTransaction: 'the first successful Pool.supply(X, amount, onBehalfOf, referral) sent by the agent key',
    oracle: 'exactly one successful exact sale of saleEth; exactly one successful supply of exactly supplyX X on behalf of the holder; final aToken >= supplyX - tolerance; final X >= reserveX',
    calibrationCheck: {aTokenAfterSupply: aBal.toString(), finalX: formatUnits(xL1, X.decimals)},
    scenarios: ['normal', 'receipt_hidden', 'sale_dropped', 'rpc_stale', 'sale_reorged'],
    agentSupport: {elizaos: 'unsupported: plugin-wallet has no lending or Aave action (subactions: transfer, swap, bridge, gov, ...)',
      agent2: 'supported: swap, then aave_supply'}});
  console.log('L1 proceeds', formatUnits(proceeds, X.decimals), 'supply', formatUnits(supplyX, X.decimals), 'reserve', formatUnits(reserveL1, X.decimals), 'aToken', aSymbol, aToken);
} finally {
  a.proc.kill(); await a.proc.exited;
}
writeFileSync(out, JSON.stringify({createdAt: new Date().toISOString(), rule: 'WS-W workflow breadth (calibrate-workflows.ts)', tasks}, null, 2) + '\n');
console.log('wrote', out);
