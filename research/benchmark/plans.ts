// Signed plans for the benchmark conditions (PREREGISTRATION.md §3), for any task in tasks.json.
//   plan_guard:        built-in target/method/recipient caveats + PlanStepEnforcer (order, once-only success)
//                      + BalanceFloorEnforcer (absolute reserve and goal floors).
//   existing_controls: MetaMask built-in caveats only: target/method/recipient, valueLte, limitedCalls = 1,
//                      and on step 2 relative erc20BalanceChange caps (X decrease <= budget at signing,
//                      Y increase >= goal).
// Both put the user's funds in a HybridDeleGator account (MetaMask delegation framework v1.3.0, deployed on
// mainnet and so on the fork) and delegate each step to the agent's key. The wallet's plan mode
// (plugin-wallet chains/evm/plan-guard.ts) redeems them; the chain decides.
// Generalizes research/agent-harness-v2/plan-setup.ts, whose delegations research/plan-guard/fork-test.ts covers.
import {createWalletClient, encodeFunctionData, http, keccak256, numberToHex, pad, concat, parseAbi, parseEther, toHex, type Address, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet} from 'viem/chains';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {toMetaMaskSmartAccount, Implementation, getSmartAccountsEnvironment, ROOT_AUTHORITY, BalanceChangeType} from '@metamask/smart-accounts-kit';
import {createCaveatBuilder, encodeDelegations} from '@metamask/smart-accounts-kit/utils';
import {USER_KEY} from '../agent-harness-v2/plan-setup';

export type GuardKind = 'plan_guard' | 'existing_controls';
export interface BenchTask {
  id: string; block: number; router: Address; weth: Address; saleEth: string;
  x: {symbol: string; address: Address; decimals: number}; y: {symbol: string; address: Address; decimals: number};
  reserveX: string; goalY: string; budgetXUnits: string; proceedsXUnits: string;
}
const PLAN_GUARD_BUILD = join(import.meta.dir, '../plan-guard/build');
const ROUTER_FN = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
const selector = (fn: 'swapExactETHForTokens' | 'swapExactTokensForTokens') => encodeFunctionData({abi: ROUTER_FN, functionName: fn as any,
  args: (fn === 'swapExactETHForTokens' ? [0n, [], '0x0000000000000000000000000000000000000000', 0n] : [0n, 0n, [], '0x0000000000000000000000000000000000000000', 0n]) as any}).slice(0, 10) as Hex;
const units = (v: string, d: number) => { const [i, f = ''] = v.split('.'); return BigInt(i + f.padEnd(d, '0').slice(0, d)); };

export interface PlanAccount { kind: GuardKind; account: Address; delegationManager: Address; planJson: string; enforcers: Record<string, Address> }

/** Deploys (plan_guard: also the research enforcers), funds and signs; call before the base snapshot. */
export async function setupGuardedAccount(kind: GuardKind, task: BenchTask, anvilUrl: string, rpc: (m: string, p?: any[]) => Promise<any>, pub: any,
  o: {agent: Address; fundWei: bigint}): Promise<PlanAccount> {
  const owner = privateKeyToAccount(USER_KEY);
  const ownerWallet = createWalletClient({chain: mainnet, transport: http(anvilUrl), account: owner});
  await rpc('anvil_setBalance', [owner.address, toHex(parseEther('1'))]);
  const mined = async (hash: Hex) => {
    for (let i = 0; i < 200; i++) { const r = await pub.getTransactionReceipt({hash}).catch(() => null); if (r) { if (r.status !== 'success') throw new Error(`setup tx failed ${hash}`); return r; } await Bun.sleep(50); }
    throw new Error(`setup tx not mined ${hash}`);
  };
  const enforcers: Record<string, Address> = {};
  if (kind === 'plan_guard') for (const name of ['PlanStepEnforcer', 'BalanceFloorEnforcer']) {
    const art = JSON.parse(readFileSync(join(PLAN_GUARD_BUILD, `${name}.json`), 'utf8'));
    enforcers[name] = (await mined(await ownerWallet.deployContract({abi: art.abi, bytecode: art.bytecode}))).contractAddress as Address;
  }
  const env = getSmartAccountsEnvironment(1);
  for (const a of [env.DelegationManager, env.SimpleFactory, env.implementations.HybridDeleGatorImpl])
    if ((await pub.getCode({address: a}) ?? '0x') === '0x') throw new Error(`MetaMask delegation framework missing at ${a}`);
  const sa = await toMetaMaskSmartAccount({client: pub, implementation: Implementation.Hybrid, deployParams: [owner.address, [], [], []],
    deploySalt: '0x', signer: {account: owner}, environment: env});
  const {factory, factoryData} = await sa.getFactoryArgs();
  if ((await pub.getCode({address: sa.address}) ?? '0x') === '0x') await mined(await ownerWallet.sendTransaction({to: factory!, data: factoryData!}));
  const account = sa.address as Address;
  await rpc('anvil_setBalance', [account, toHex(o.fundWei)]);

  const saleWei = parseEther(task.saleEth), reserve = units(task.reserveX, task.x.decimals), goal = units(task.goalY, task.y.decimals);
  const planId = keccak256(toHex(`plan:${task.id}:${account}`));
  const stepTerms = (step: number, prereq: bigint) => concat([planId, numberToHex(step, {size: 1}), pad(numberToHex(prereq), {size: 32})]);
  const floorTerms = (token: Address, min: bigint) => concat([token, pad(numberToHex(min), {size: 32})]);
  const builtIn = (fn: (b: any) => any) => fn(createCaveatBuilder(env)).build();
  const recipientIs = (offset: number) => ({startIndex: offset, value: pad(account, {size: 32})});
  let salt = 0;
  const signed = async (caveats: any[]) => {
    const d = {delegate: o.agent, delegator: account, authority: ROOT_AUTHORITY as Hex, caveats, salt: numberToHex(++salt, {size: 32})};
    return encodeDelegations([{...d, signature: await sa.signDelegation({delegation: d})}]) as Hex;
  };
  const saleBase = (b: any) => b.addCaveat('allowedTargets', {targets: [task.router]}).addCaveat('allowedMethods', {selectors: [selector('swapExactETHForTokens')]})
    .addCaveat('valueLte', {maxValue: saleWei}).addCaveat('allowedCalldata', recipientIs(4 + 32 * 2));
  const step2Base = (b: any) => b.addCaveat('allowedTargets', {targets: [task.router]}).addCaveat('allowedMethods', {selectors: [selector('swapExactTokensForTokens')]})
    .addCaveat('allowedCalldata', recipientIs(4 + 32 * 3));
  let sale: Hex, step2: Hex;
  if (kind === 'plan_guard') {
    sale = await signed([...builtIn(saleBase), {enforcer: enforcers.PlanStepEnforcer, terms: stepTerms(0, 0n), args: '0x'}]);
    step2 = await signed([...builtIn(step2Base), {enforcer: enforcers.PlanStepEnforcer, terms: stepTerms(1, 1n), args: '0x'},
      {enforcer: enforcers.BalanceFloorEnforcer, terms: floorTerms(task.x.address, reserve), args: '0x'},
      {enforcer: enforcers.BalanceFloorEnforcer, terms: floorTerms(task.y.address, goal), args: '0x'}]);
  } else {
    sale = await signed(builtIn(b => saleBase(b).addCaveat('limitedCalls', {limit: 1})));
    step2 = await signed(builtIn(b => step2Base(b).addCaveat('limitedCalls', {limit: 1})
      .addCaveat('erc20BalanceChange', {tokenAddress: task.x.address, recipient: account, balance: BigInt(task.budgetXUnits), changeType: BalanceChangeType.Decrease})
      .addCaveat('erc20BalanceChange', {tokenAddress: task.y.address, recipient: account, balance: goal, changeType: BalanceChangeType.Increase})));
  }
  const approve = await signed(builtIn(b => b.addCaveat('allowedTargets', {targets: [task.x.address]}).addCaveat('allowedMethods', {selectors: ['0x095ea7b3']})
    .addCaveat('allowedCalldata', {startIndex: 4, value: pad(task.router, {size: 32})})));
  const NATIVE = '0x0000000000000000000000000000000000000000';
  const plan = {account, delegationManager: env.DelegationManager, steps: [
    {step: 0, fromToken: NATIVE, toToken: task.x.address, maxAmountIn: saleWei.toString(), permissionContext: sale},
    {step: 1, fromToken: task.x.address, toToken: task.y.address, maxAmountIn: (10n ** 30n).toString(), permissionContext: step2},
  ], approvals: [{token: task.x.address, spender: task.router, permissionContext: approve}]};
  return {kind, account, delegationManager: env.DelegationManager as Address, planJson: JSON.stringify(plan), enforcers};
}
