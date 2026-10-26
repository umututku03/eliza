// Calibrates the benchmark tasks (PREREGISTRATION.md §4.1) on the pinned fork and writes tasks.json.
// No model calls. Refuses to overwrite. D1 must reproduce the frozen development task exactly.
// Usage (repo root): ANVIL_BIN=<anvil> bun --conditions=eliza-source --env-file=<fork .env> research/benchmark/calibrate-tasks.ts --out=research/benchmark/tasks.json
import {createWalletClient, http, parseEther, formatUnits, type Address} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet} from 'viem/chains';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {startAnvil, fundAgent, quote, balance, ROUTER, WETH, USDC, DAI, AGENT, AGENT_KEY, AGENT_ETH, ANVIL_PORT} from '../agent-harness-v2/fork-oracle';

const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
if (!out) throw new Error('--out=<json> required');
if (existsSync(out)) throw new Error('tasks file exists; never overwrite a frozen benchmark');

const TOKENS = {USDC: {address: USDC, decimals: 6}, DAI: {address: DAI, decimals: 18}} as const;
type Sym = keyof typeof TOKENS;
// Fixed calibration rule (PREREGISTRATION.md §4.1).
const BUDGET_SHARE_BPS = 2500n;
const TASKS: {id: string; split: 'development' | 'held-out'; block: number; saleEth: string; x: Sym; y: Sym; rho: number; factors?: {feasible: number; infeasible: number}}[] = [
  {id: 'D1', split: 'development', block: 26250601, saleEth: '0.1', x: 'USDC', y: 'DAI', rho: 50 / (80 * 997 * 10000 / (10000 * 1000 + 80 * 997)), factors: {feasible: 0.73, infeasible: 0.58}},
  {id: 'H1', split: 'held-out', block: 26250601, saleEth: '0.08', x: 'DAI', y: 'USDC', rho: 0.632},
  {id: 'H2', split: 'held-out', block: 26250601, saleEth: '0.05', x: 'USDC', y: 'DAI', rho: 0.85},
  {id: 'H3', split: 'held-out', block: 26100000, saleEth: '0.1', x: 'USDC', y: 'DAI', rho: 0.632},
];
const SWAP_ABI = [{type: 'function', name: 'swapExactETHForTokens', stateMutability: 'payable', inputs: [{name: 'amountOutMin', type: 'uint256'},
  {name: 'path', type: 'address[]'}, {name: 'to', type: 'address'}, {name: 'deadline', type: 'uint256'}], outputs: [{type: 'uint256[]'}]}] as const;
const cents = (decimals: number) => 10n ** BigInt(decimals - 2);

const results: any[] = [];
for (const t of TASKS) {
  const a = await startAnvil(t.block);
  try {
    await fundAgent(a);
    const X = TOKENS[t.x], Y = TOKENS[t.y];
    const sale = parseEther(t.saleEth);
    const url = `http://127.0.0.1:${ANVIL_PORT}`;
    const agent = createWalletClient({chain: mainnet, transport: http(url), account: privateKeyToAccount(AGENT_KEY)});
    const send = async (w: any, value: bigint, path: Address[], to: Address) => {
      const hash = await w.writeContract({address: ROUTER, abi: SWAP_ABI, functionName: 'swapExactETHForTokens', args: [0n, path, to, (await a.pub.getBlock()).timestamp + 3600n], value, gas: 300000n});
      for (let i = 0; i < 200; i++) { const r = await a.pub.getTransactionReceipt({hash}).catch(() => null); if (r) { if (r.status !== 'success') throw new Error('swap reverted'); return; } await Bun.sleep(50); }
      throw new Error('swap not mined');
    };
    const expectedProceeds = await quote(a.pub, sale, [WETH, X.address]);
    const base = await a.rpc('evm_snapshot');
    await send(agent, sale, [WETH, X.address], AGENT);
    const proceeds = await balance(a.pub, X.address, AGENT);
    if (proceeds !== expectedProceeds) throw new Error(`${t.id}: sale did not match its quote`);
    const share = proceeds * BUDGET_SHARE_BPS / 10000n;
    const reserve = ((proceeds - share + cents(X.decimals) - 1n) / cents(X.decimals)) * cents(X.decimals);
    const budget = proceeds - reserve;
    const path = [X.address, WETH, Y.address] as Address[];
    const baselineOut = await quote(a.pub, budget, path);
    const goal = BigInt(Math.floor(Number(baselineOut) * t.rho / Number(cents(Y.decimals)))) * cents(Y.decimals);
    const factors = t.factors ?? {feasible: t.rho + 0.4 * (1 - t.rho), infeasible: t.rho - 0.05};
    let afterSale = await a.rpc('evm_snapshot');
    const restore = async () => { await a.rpc('evm_revert', [afterSale]); afterSale = await a.rpc('evm_snapshot'); };
    const moves: Record<string, any> = {};
    for (const [name, factor] of Object.entries({price_change_feasible: factors.feasible, price_change_infeasible: factors.infeasible})) {
      const target = BigInt(Math.floor(Number(baselineOut) * factor));
      let lo = 0n, hi = parseEther('5000');
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2n;
        await restore(); await send(a.mover, mid, [WETH, Y.address], a.mover.account.address);
        if (await quote(a.pub, budget, path) > target) lo = mid; else hi = mid;
      }
      const eth = (lo / 10n ** 15n) * 10n ** 15n;   // 0.001 ETH steps
      await restore(); await send(a.mover, eth, [WETH, Y.address], a.mover.account.address);
      const budgetOut = await quote(a.pub, budget, path);
      moves[name] = {moverEthWei: eth.toString(), budgetYOutUnits: budgetOut.toString(), feasible: budgetOut >= goal};
    }
    if (!moves.price_change_feasible.feasible || moves.price_change_infeasible.feasible) throw new Error(`${t.id}: price moves do not give the feasible/infeasible pair`);
    await a.rpc('evm_revert', [base]);
    results.push({id: t.id, split: t.split, block: t.block, agent: AGENT, agentEth: AGENT_ETH, router: ROUTER, weth: WETH,
      x: {symbol: t.x, ...X}, y: {symbol: t.y, ...Y}, path, saleEth: t.saleEth,
      proceedsXUnits: proceeds.toString(), budgetXUnits: budget.toString(), reserveX: formatUnits(reserve, X.decimals),
      baselineYOutUnits: baselineOut.toString(), goalY: formatUnits(goal, Y.decimals), goalRatio: t.rho, factors, moves});
    console.log(t.id, 'reserve', formatUnits(reserve, X.decimals), t.x, 'budget', formatUnits(budget, X.decimals), 'goal', formatUnits(goal, Y.decimals), t.y,
      'moves', moves.price_change_feasible.moverEthWei, moves.price_change_infeasible.moverEthWei);
  } finally {
    a.proc.kill(); await a.proc.exited;
  }
}
// D1 must equal the frozen development task (research/agent-harness-v2/frozen-task.json).
const frozen = JSON.parse(readFileSync(join(import.meta.dir, '../agent-harness-v2/frozen-task.json'), 'utf8'));
const d1 = results.find(r => r.id === 'D1');
const same = d1.proceedsXUnits === frozen.proceedsUsdcUnits && d1.budgetXUnits === frozen.budgetUsdcUnits && d1.reserveX === frozen.reserveUsdc
  && d1.goalY === frozen.goalDai && d1.moves.price_change_feasible.moverEthWei === frozen.moves.price_change_feasible.moverEthWei
  && d1.moves.price_change_infeasible.moverEthWei === frozen.moves.price_change_infeasible.moverEthWei;
if (!same) throw new Error(`D1 does not reproduce the frozen development task: ${JSON.stringify(d1)}`);
writeFileSync(out, JSON.stringify({createdAt: new Date().toISOString(), rule: 'PREREGISTRATION.md §4.1', tasks: results}, null, 2) + '\n');
console.log('wrote', out);
