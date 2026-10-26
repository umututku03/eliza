// Plan-guard condition setup: plays the user's wallet. It deploys the research/plan-guard enforcers, creates
// the user's HybridDeleGator account (MetaMask delegation framework v1.3.0, already deployed on mainnet and
// so on the fork), moves the user's funds into it, and signs the frozen task as a plan: one delegation per
// step to the agent's key. Mirrors research/plan-guard/fork-test.ts, whose 15 cases cover these delegations.
import {createWalletClient, decodeFunctionData, encodeFunctionData, http, keccak256, numberToHex, pad, concat, parseAbi, parseEther,
  toHex, type Address, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet} from 'viem/chains';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {toMetaMaskSmartAccount, Implementation, getSmartAccountsEnvironment, ROOT_AUTHORITY} from '@metamask/smart-accounts-kit';
import {createCaveatBuilder, encodeDelegations} from '@metamask/smart-accounts-kit/utils';

// Fork-only deterministic key for the user (owner of the plan account); never the agent's key.
export const USER_KEY = keccak256(toHex('agent-harness-v2-plan-owner-v1'));
const PLAN_GUARD_BUILD = join(import.meta.dir, '../plan-guard/build');
const ROUTER_FN = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
const DM_ABI = parseAbi(['function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)']);
const selector = (fn: 'swapExactETHForTokens' | 'swapExactTokensForTokens') => encodeFunctionData({abi: ROUTER_FN, functionName: fn as any,
  args: (fn === 'swapExactETHForTokens' ? [0n, [], '0x0000000000000000000000000000000000000000', 0n] : [0n, 0n, [], '0x0000000000000000000000000000000000000000', 0n]) as any}).slice(0, 10) as Hex;

export interface PlanSetup {
  account: Address;
  delegationManager: Address;
  enforcers: {planStep: Address; balanceFloor: Address};
  planJson: string;
}

/** Deploys and signs everything on the current fork state; call before the base snapshot. */
export async function setupPlanAccount(anvilUrl: string, rpc: (m: string, p?: any[]) => Promise<any>, pub: any, o: {
  agent: Address; router: Address; usdc: Address; dai: Address; saleWei: bigint; reserveUsdcUnits: bigint; goalDaiWei: bigint; fundWei: bigint;
}): Promise<PlanSetup> {
  const owner = privateKeyToAccount(USER_KEY);
  const ownerWallet = createWalletClient({chain: mainnet, transport: http(anvilUrl), account: owner});
  await rpc('anvil_setBalance', [owner.address, toHex(parseEther('1'))]);
  const mined = async (hash: Hex) => {
    for (let i = 0; i < 200; i++) { const r = await pub.getTransactionReceipt({hash}).catch(() => null); if (r) { if (r.status !== 'success') throw new Error(`setup tx failed ${hash}`); return r; } await Bun.sleep(50); }
    throw new Error(`setup tx not mined ${hash}`);
  };
  const deploy = async (name: string) => {
    const art = JSON.parse(readFileSync(join(PLAN_GUARD_BUILD, `${name}.json`), 'utf8'));
    return (await mined(await ownerWallet.deployContract({abi: art.abi, bytecode: art.bytecode}))).contractAddress as Address;
  };
  const planStep = await deploy('PlanStepEnforcer'), balanceFloor = await deploy('BalanceFloorEnforcer');

  const env = getSmartAccountsEnvironment(1);
  for (const a of [env.DelegationManager, env.SimpleFactory, env.implementations.HybridDeleGatorImpl])
    if ((await pub.getCode({address: a}) ?? '0x') === '0x') throw new Error(`MetaMask delegation framework missing at ${a}`);
  const sa = await toMetaMaskSmartAccount({client: pub, implementation: Implementation.Hybrid, deployParams: [owner.address, [], [], []],
    deploySalt: '0x', signer: {account: owner}, environment: env});
  const {factory, factoryData} = await sa.getFactoryArgs();
  await mined(await ownerWallet.sendTransaction({to: factory!, data: factoryData!}));
  const account = sa.address as Address;
  await rpc('anvil_setBalance', [account, toHex(o.fundWei)]);

  const planId = keccak256(toHex(`plan:${account}:sell ${o.saleWei} wei ETH->USDC; then >= ${o.goalDaiWei} DAI wei keeping >= ${o.reserveUsdcUnits} USDC units`));
  const stepTerms = (step: number, prereq: bigint) => concat([planId, numberToHex(step, {size: 1}), pad(numberToHex(prereq), {size: 32})]);
  const floorTerms = (token: Address, min: bigint) => concat([token, pad(numberToHex(min), {size: 32})]);
  const builtIn = (fn: (b: any) => any) => fn(createCaveatBuilder(env)).build();
  const recipientIs = (offset: number) => ({startIndex: offset, value: pad(account, {size: 32})});
  let salt = 0;
  const signed = async (caveats: any[]) => {
    const d = {delegate: o.agent, delegator: account, authority: ROOT_AUTHORITY as Hex, caveats, salt: numberToHex(++salt, {size: 32})};
    return encodeDelegations([{...d, signature: await sa.signDelegation({delegation: d})}]) as Hex;
  };
  const sale = await signed([...builtIn(b => b.addCaveat('allowedTargets', {targets: [o.router]}).addCaveat('allowedMethods', {selectors: [selector('swapExactETHForTokens')]})
    .addCaveat('valueLte', {maxValue: o.saleWei}).addCaveat('allowedCalldata', recipientIs(4 + 32 * 2))),
    {enforcer: planStep, terms: stepTerms(0, 0n), args: '0x'}]);
  const step2 = await signed([...builtIn(b => b.addCaveat('allowedTargets', {targets: [o.router]}).addCaveat('allowedMethods', {selectors: [selector('swapExactTokensForTokens')]})
    .addCaveat('allowedCalldata', recipientIs(4 + 32 * 3))),
    {enforcer: planStep, terms: stepTerms(1, 1n), args: '0x'},
    {enforcer: balanceFloor, terms: floorTerms(o.usdc, o.reserveUsdcUnits), args: '0x'}, {enforcer: balanceFloor, terms: floorTerms(o.dai, o.goalDaiWei), args: '0x'}]);
  const approve = await signed(builtIn(b => b.addCaveat('allowedTargets', {targets: [o.usdc]}).addCaveat('allowedMethods', {selectors: ['0x095ea7b3']})
    .addCaveat('allowedCalldata', {startIndex: 4, value: pad(o.router, {size: 32})})));
  const NATIVE = '0x0000000000000000000000000000000000000000';
  const plan = {account, delegationManager: env.DelegationManager, steps: [
    {step: 0, fromToken: NATIVE, toToken: o.usdc, maxAmountIn: o.saleWei.toString(), permissionContext: sale},
    {step: 1, fromToken: o.usdc, toToken: o.dai, maxAmountIn: (10n ** 30n).toString(), permissionContext: step2},
  ], approvals: [{token: o.usdc, spender: o.router, permissionContext: approve}]};
  return {account, delegationManager: env.DelegationManager as Address, enforcers: {planStep, balanceFloor}, planJson: JSON.stringify(plan)};
}

/** The execution inside a DelegationManager.redeemDelegations call (single-call mode), or null. */
export function decodeRedemption(data: Hex): {target: Address; value: bigint; callData: Hex} | null {
  try {
    const d = decodeFunctionData({abi: DM_ABI, data});
    const exec = (d.args[2] as Hex[])[0];
    // encodePacked(address target, uint256 value, bytes callData)
    return {target: `0x${exec.slice(2, 42)}` as Address, value: BigInt(`0x${exec.slice(42, 106)}`), callData: `0x${exec.slice(106)}` as Hex};
  } catch { return null; }
}
