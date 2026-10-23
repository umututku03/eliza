// Fork test of PlanStepEnforcer and BalanceFloorEnforcer against MetaMask's deployed delegation framework (v1.3.0)
// on the pinned mainnet fork, using the frozen two-step task. No model calls.
//
// The user holds a HybridDeleGator smart account and signs the whole plan before step 1. The agent (an EOA)
// redeems one delegation per transaction. Each case runs from the same post-setup snapshot, and the result
// (admitted or refused with reason, gas) comes from the chain.
// Usage: bun --env-file=<fork .env> fork-test.ts --out=<json>
import {createPublicClient, createWalletClient, http, parseEther, parseUnits, formatUnits, encodeFunctionData, keccak256, toHex,
  pad, concat, numberToHex, type Address, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {mainnet} from 'viem/chains';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {toMetaMaskSmartAccount, Implementation, getSmartAccountsEnvironment, ROOT_AUTHORITY, ExecutionMode, createExecution, BalanceChangeType}
  from '@metamask/smart-accounts-kit';
import {createCaveatBuilder, encodeDelegations, encodeExecutionCalldatas, decodeRevertData} from '@metamask/smart-accounts-kit/utils';
import {DelegationManager as DM_ABI} from '@metamask/delegation-abis';

const frozen = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/frozen-task.json'), 'utf8'));
const out = process.argv.find(a => a.startsWith('--out='))?.slice(6);
if (!out) throw new Error('--out=<json> required');
const ROUTER: Address = frozen.router, [USDC, WETH, DAI] = frozen.path as Address[];
const R = parseUnits(frozen.reserveUsdc, 6), G = parseUnits(frozen.goalDai, 18), SALE = parseEther(frozen.saleEth);
const BUDGET = BigInt(frozen.budgetUsdcUnits);
const PORT = 18546, URL = `http://127.0.0.1:${PORT}`;

// Fork-only deterministic test keys (no mainnet history). The mover is Anvil's well-known dev account #1.
const OWNER = privateKeyToAccount(keccak256(toHex('plan-guard-owner-v1')));
const AGENT = privateKeyToAccount(keccak256(toHex('plan-guard-agent-v1')));
const MOVER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const ROUTER_ABI = [
  {type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [{name: 'amountIn', type: 'uint256'}, {name: 'path', type: 'address[]'}], outputs: [{type: 'uint256[]'}]},
  {type: 'function', name: 'swapExactETHForTokens', stateMutability: 'payable', inputs: [{name: 'amountOutMin', type: 'uint256'}, {name: 'path', type: 'address[]'}, {name: 'to', type: 'address'}, {name: 'deadline', type: 'uint256'}], outputs: [{type: 'uint256[]'}]},
  {type: 'function', name: 'swapExactTokensForTokens', stateMutability: 'nonpayable', inputs: [{name: 'amountIn', type: 'uint256'}, {name: 'amountOutMin', type: 'uint256'}, {name: 'path', type: 'address[]'}, {name: 'to', type: 'address'}, {name: 'deadline', type: 'uint256'}], outputs: [{type: 'uint256[]'}]},
] as const;
const ERC20_ABI = [
  {type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{name: 'a', type: 'address'}], outputs: [{type: 'uint256'}]},
  {type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{name: 's', type: 'address'}, {name: 'v', type: 'uint256'}], outputs: [{type: 'bool'}]},
] as const;
const sel = (name: string) => (ROUTER_ABI.find(f => f.name === name) ? encodeFunctionData({abi: ROUTER_ABI as any, functionName: name as any, args: name === 'swapExactETHForTokens' ? [0n, [], OWNER.address, 0n] : [0n, 0n, [], OWNER.address, 0n]}) : '0x').slice(0, 10) as Hex;

// --- fork ---
const forkUrl = process.env.MAINNET_FORK_RPC_URL;
if (!forkUrl) throw new Error('Set MAINNET_FORK_RPC_URL');
const anvilBin = process.env.ANVIL_BIN;
if (!anvilBin) throw new Error('Set ANVIL_BIN');
const proc = Bun.spawn([anvilBin, '--host', '127.0.0.1', '--port', String(PORT), '--fork-url', forkUrl, '--fork-block-number', String(frozen.block),
  '--retries', '10', '--timeout', '60000'], {stdout: 'ignore', stderr: 'ignore', env: {PATH: process.env.PATH ?? '/usr/bin:/bin'}});
const rpc = async (method: string, params: any[] = []) => {
  const r: any = await (await fetch(URL, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})})).json();
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const transport = http(URL, {retryCount: 0});
const pub = createPublicClient({chain: mainnet, transport, pollingInterval: 50});
const wallet = (account: any) => createWalletClient({chain: mainnet, transport, account});
const mined = async (hash: Hex) => {
  for (let i = 0; i < 200; i++) { const r = await pub.getTransactionReceipt({hash}).catch(() => null); if (r) return r; await Bun.sleep(50); }
  throw new Error(`not mined: ${hash}`);
};
const bal = (token: Address, who: Address) => pub.readContract({address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who]}) as Promise<bigint>;
const quote = async (amountIn: bigint, path: Address[]) => ((await pub.readContract({address: ROUTER, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [amountIn, path]})) as bigint[]).at(-1)!;
const deadline = async () => (await pub.getBlock()).timestamp + 3600n;

const results: any = {block: frozen.block, framework: '1.3.0', cases: []};
try {
  for (let i = 0; i < 200; i++) { try { if (await rpc('eth_chainId') === '0x1') break; } catch {} await Bun.sleep(100); }
  if (Number(await rpc('eth_blockNumber')) !== frozen.block) throw new Error('fork head is not the pinned block');
  await rpc('anvil_setBlockTimestampInterval', [12]);

  const env = getSmartAccountsEnvironment(1);
  for (const [name, addr] of Object.entries({DelegationManager: env.DelegationManager, SimpleFactory: env.SimpleFactory, HybridDeleGatorImpl: env.implementations.HybridDeleGatorImpl,
    ...env.caveatEnforcers}))
    if ((await pub.getCode({address: addr as Address}) ?? '0x') === '0x') throw new Error(`${name} has no code at the pinned block`);
  results.deployedCodeChecked = Object.keys(env.caveatEnforcers).length + 3;

  for (const a of [OWNER, AGENT, MOVER]) await rpc('anvil_setBalance', [a.address, toHex(parseEther(a === MOVER ? '100000' : '1'))]);

  // Our enforcers.
  const deploy = async (name: string) => {
    const art = JSON.parse(readFileSync(join(import.meta.dir, 'build', `${name}.json`), 'utf8'));
    const r = await mined(await wallet(OWNER).deployContract({abi: art.abi, bytecode: art.bytecode}));
    return {address: r.contractAddress as Address, gas: r.gasUsed.toString()};
  };
  const planStep = await deploy('PlanStepEnforcer'), floor = await deploy('BalanceFloorEnforcer');
  results.deployGas = {PlanStepEnforcer: planStep.gas, BalanceFloorEnforcer: floor.gas};

  // User smart account.
  const account = await toMetaMaskSmartAccount({client: pub as any, implementation: Implementation.Hybrid, deployParams: [OWNER.address, [], [], []],
    deploySalt: '0x', signer: {account: OWNER}, environment: env});
  const {factory, factoryData} = await account.getFactoryArgs();
  await mined(await wallet(OWNER).sendTransaction({to: factory!, data: factoryData!}));
  const A = account.address;
  await rpc('anvil_setBalance', [A, toHex(parseEther('1'))]);
  results.account = {address: A, implementation: 'HybridDeleGator'};

  // --- plan delegations, all signed before step 1 ---
  const planId = keccak256(toHex(`plan:${frozen.block}:${A}:sell ${frozen.saleEth} ETH->USDC; then >= ${frozen.goalDai} DAI keeping >= ${frozen.reserveUsdc} USDC`));
  const stepTerms = (step: number, prereq: bigint) => concat([planId, numberToHex(step, {size: 1}), pad(numberToHex(prereq), {size: 32})]);
  const floorTerms = (token: Address, min: bigint) => concat([token, pad(numberToHex(min), {size: 32})]);
  const recipientIs = (offset: number) => ({startIndex: offset, value: pad(A, {size: 32})});
  let salt = 0;
  const sign = async (caveats: any[]) => {
    const d = {delegate: AGENT.address, delegator: A, authority: ROOT_AUTHORITY as Hex, caveats, salt: numberToHex(++salt, {size: 32})};
    return {...d, signature: await account.signDelegation({delegation: d})};
  };
  const builtIn = (fn: (b: any) => any) => fn(createCaveatBuilder(env)).build();
  const sellCaveats = (extra: any[] = []) => [...builtIn(b => b
    .addCaveat('allowedTargets', {targets: [ROUTER]})
    .addCaveat('allowedMethods', {selectors: [sel('swapExactETHForTokens')]})
    .addCaveat('valueLte', {maxValue: SALE})
    .addCaveat('allowedCalldata', recipientIs(4 + 32 * 2))), ...extra];
  const step2Base = () => builtIn(b => b
    .addCaveat('allowedTargets', {targets: [ROUTER]})
    .addCaveat('allowedMethods', {selectors: [sel('swapExactTokensForTokens')]})
    .addCaveat('allowedCalldata', recipientIs(4 + 32 * 3)));
  const approveCaveats = builtIn(b => b
    .addCaveat('allowedTargets', {targets: [USDC]})
    .addCaveat('allowedMethods', {selectors: ['0x095ea7b3']})
    .addCaveat('allowedCalldata', {startIndex: 4, value: pad(ROUTER, {size: 32})}));
  const ourStep2 = [...step2Base(), {enforcer: planStep.address, terms: stepTerms(1, 1n), args: '0x'},
    {enforcer: floor.address, terms: floorTerms(USDC, R), args: '0x'}, {enforcer: floor.address, terms: floorTerms(DAI, G), args: '0x'}];
  const relStep2 = (cap: bigint) => [...step2Base(), ...builtIn(b => b
    .addCaveat('erc20BalanceChange', {tokenAddress: USDC, recipient: A, balance: cap, changeType: BalanceChangeType.Decrease})
    .addCaveat('erc20BalanceChange', {tokenAddress: DAI, recipient: A, balance: G, changeType: BalanceChangeType.Increase}))];
  const plans = {
    perTx: {sell: await sign(sellCaveats())},
    limitedCalls: {sell: await sign(sellCaveats(builtIn(b => b.addCaveat('limitedCalls', {limit: 1}))))},
    ours: {sell: await sign(sellCaveats([{enforcer: planStep.address, terms: stepTerms(0, 0n), args: '0x'}])), step2: await sign(ourStep2)},
    relExpected: {step2: await sign(relStep2(BUDGET))},
    relWorstCase: {step2: await sign(relStep2(52277381n))},
    approve: await sign(approveCaveats),
  };

  // --- redemption helper: simulate for the revert reason, then send ---
  // force: send even when simulation fails, so a revert is mined on chain (used to test that it rolls back state).
  const redeem = async (delegation: any, target: Address, value: bigint, callData: Hex, force = false) => {
    const args = [[encodeDelegations([delegation])], [ExecutionMode.SingleDefault], encodeExecutionCalldatas([[createExecution({target, value, callData})]])] as const;
    try {
      await pub.simulateContract({address: env.DelegationManager, abi: DM_ABI as any, functionName: 'redeemDelegations', args, account: AGENT});
    } catch (e: any) {
      const data = e?.cause?.data ?? e?.cause?.cause?.data ?? e?.data;
      const decoded = typeof data === 'string' ? decodeRevertData(data as Hex) : (data?.errorName ? {errorName: data.errorName, message: (data.args ?? []).join(',')} : undefined);
      const reason = decoded?.message || decoded?.errorName || e?.cause?.reason || e?.shortMessage?.slice(0, 160);
      if (!force) return {admitted: false, reason};
      const r = await mined(await wallet(AGENT).writeContract({address: env.DelegationManager, abi: DM_ABI as any, functionName: 'redeemDelegations', args, gas: 2_000_000n}));
      return {admitted: r.status === 'success', minedStatus: r.status, gas: r.gasUsed.toString(), reason};
    }
    const r = await mined(await wallet(AGENT).writeContract({address: env.DelegationManager, abi: DM_ABI as any, functionName: 'redeemDelegations', args, gas: 2_000_000n}));
    return {admitted: r.status === 'success', gas: r.gasUsed.toString(), reason: r.status === 'success' ? null : 'reverted on chain'};
  };
  const sellData = async (minOut = 0n) => encodeFunctionData({abi: ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [minOut, [WETH, USDC], A, await deadline()]});
  const step2Data = async (amountIn: bigint) => encodeFunctionData({abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [amountIn, 0n, [USDC, WETH, DAI], A, await deadline()]});
  const approveData = encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, 2n ** 256n - 1n]});
  const moveMarket = async (eth: bigint, path: Address[]) => {
    if (eth === 0n) return;
    const r = await mined(await wallet(MOVER).writeContract({address: ROUTER, abi: ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [0n, path, MOVER.address, await deadline()], value: eth, gas: 300000n}));
    if (r.status !== 'success') throw new Error('market move reverted');
  };
  const state = async () => ({usdc: formatUnits(await bal(USDC, A), 6), dai: formatUnits(await bal(DAI, A), 18)});

  let base = await rpc('evm_snapshot');
  const fresh = async () => { await rpc('evm_revert', [base]); base = await rpc('evm_snapshot'); };
  const record = (name: string, expect: 'admit' | 'refuse', steps: any[], extra: any = {}) => {
    const last = steps.at(-1);
    const pass = (expect === 'admit') === last.admitted;
    results.cases.push({name, expect, pass, steps, ...extra});
    console.log(pass ? 'PASS' : 'FAIL', name, '->', last.admitted ? 'admitted' : `refused: ${last.reason}`);
  };

  // Baseline gas: the same sale sent directly from an EOA (no delegation).
  await fresh();
  await rpc('anvil_setBalance', [OWNER.address, toHex(parseEther('1'))]);
  const direct = await mined(await wallet(OWNER).writeContract({address: ROUTER, abi: ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [0n, [WETH, USDC], OWNER.address, await deadline()], value: SALE}));
  results.directSaleGas = direct.gasUsed.toString();

  // 1. Legitimate plan under our enforcers: sale, approve, step 2 with the frozen budget.
  await fresh();
  {
    const s = [await redeem(plans.ours.sell, ROUTER, SALE, await sellData()), await redeem(plans.approve, USDC, 0n, approveData),
      await redeem(plans.ours.step2, ROUTER, 0n, await step2Data(BUDGET))];
    record('ours: legitimate plan (sell, approve, step 2 with frozen budget)', 'admit', s, {final: await state()});
  }
  // 2. Recorded failure: repeated exact sale after step 1 succeeded (50 recorded cases have this shape).
  for (const [cfg, label] of [['perTx', 'per-transaction policy'], ['limitedCalls', 'limitedCalls = 1'], ['ours', 'ours']] as const) {
    await fresh();
    const s = [await redeem((plans as any)[cfg].sell, ROUTER, SALE, await sellData()), await redeem((plans as any)[cfg].sell, ROUTER, SALE, await sellData())];
    record(`${label}: repeated 0.1 ETH sale after step 1`, cfg === 'perTx' ? 'admit' : 'refuse', s);
  }
  // 3. Recorded failure: risk-clamped repeat (smaller than the step value).
  for (const [cfg, label] of [['perTx', 'per-transaction policy'], ['ours', 'ours']] as const) {
    await fresh();
    const s = [await redeem((plans as any)[cfg].sell, ROUTER, SALE, await sellData()), await redeem((plans as any)[cfg].sell, ROUTER, 99825745008281090n, await sellData())];
    record(`${label}: risk-clamped repeat sale (0.0998 ETH)`, cfg === 'perTx' ? 'admit' : 'refuse', s);
  }
  // 4. Step 2 before step 1.
  await fresh();
  {
    await rpc('anvil_setBalance', [A, toHex(parseEther('1'))]);
    // Give the account USDC by a direct owner-side sale so step 2 is otherwise executable; the plan still has no step 1.
    const s = [await redeem(plans.perTx.sell, ROUTER, SALE, await sellData()), await redeem(plans.approve, USDC, 0n, approveData),
      await redeem(plans.ours.step2, ROUTER, 0n, await step2Data(BUDGET))];
    record('ours: step 2 before plan step 1 (funds present from outside the plan)', 'refuse', s);
  }
  // 5. Reverted step 1 can be retried (completion is rolled back with the revert).
  await fresh();
  {
    const s = [await redeem(plans.ours.sell, ROUTER, SALE, await sellData(10n ** 30n), true), await redeem(plans.ours.sell, ROUTER, SALE, await sellData())];
    if (s[0].minedStatus !== 'reverted') throw new Error('step-1 revert was not mined on chain');
    record('ours: step 1 reverts on chain (amountOutMin unreachable), then retried', 'admit', s);
  }
  // 6. Step 2 overspends and breaks the reserve.
  await fresh();
  {
    const s = [await redeem(plans.ours.sell, ROUTER, SALE, await sellData()), await redeem(plans.approve, USDC, 0n, approveData),
      await redeem(plans.ours.step2, ROUTER, 0n, await step2Data(BUDGET + 5_000_000n))];
    record('ours: step 2 spends 5 USDC beyond the surplus (reserve broken)', 'refuse', s);
  }
  // 7. Step 2 under-delivers the goal, then a corrected step 2 is admitted.
  await fresh();
  {
    const s = [await redeem(plans.ours.sell, ROUTER, SALE, await sellData()), await redeem(plans.approve, USDC, 0n, approveData),
      await redeem(plans.ours.step2, ROUTER, 0n, await step2Data(20_000_000n))];
    record('ours: step 2 spends 20 USDC (goal not reached)', 'refuse', s);
    const retry = await redeem(plans.ours.step2, ROUTER, 0n, await step2Data(BUDGET));
    record('ours: corrected step 2 after the refused one', 'admit', [...s, retry]);
  }
  // 8. Expressiveness cells from expressiveness-check.ts, now with the deployed relative enforcer vs ours.
  //    (a) step 1 under-delivers by 3% (pre-sale WETH/USDC move); step 2 spends the expected surplus 59.406476.
  //    (b) step 1 as expected; DAI price moved by 350 ETH; step 2 spends s* = 52.82 USDC (feasible, keeps reserve).
  const PRE3 = parseEther('63.666432379250181837');
  const cell = async (pre: bigint, daiMove: bigint, spend: bigint, plan: any) => {
    await fresh();
    await moveMarket(pre, [WETH, USDC]);
    const s1 = await redeem(plans.ours.sell, ROUTER, SALE, await sellData());
    await moveMarket(daiMove, [WETH, DAI]);
    const s2 = await redeem(plans.approve, USDC, 0n, approveData);
    return [s1, s2, await redeem(plan, ROUTER, 0n, await step2Data(spend))];
  };
  record('relative cap 59.41 (expected): step 1 -3%, step 2 spends 59.41 (reserve broken)', 'admit', await cell(PRE3, 0n, BUDGET, plans.relExpected.step2), {final: await state()});
  record('ours: step 1 -3%, step 2 spends 59.41 (reserve broken)', 'refuse', await cell(PRE3, 0n, BUDGET, plans.ours.step2));
  record('relative cap 52.28 (worst case): DAI move 350 ETH, step 2 spends 52.82 (feasible)', 'refuse', await cell(0n, parseEther('350'), 52_820_000n, plans.relWorstCase.step2));
  record('ours: DAI move 350 ETH, step 2 spends 52.82 (feasible)', 'admit', await cell(0n, parseEther('350'), 52_820_000n, plans.ours.step2), {final: await state()});

  // Gas of admitted redemptions, by case, for the overhead table.
  results.gas = results.cases.flatMap((c: any) => c.steps.filter((x: any) => x.admitted).map((x: any) => ({case: c.name, gas: x.gas})));
  results.passed = results.cases.filter((c: any) => c.pass).length;
  results.total = results.cases.length;
  console.log(`${results.passed}/${results.total} cases as expected; direct sale gas ${results.directSaleGas}`);
} finally {
  writeFileSync(out, JSON.stringify(results, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
  proc.kill();
}
