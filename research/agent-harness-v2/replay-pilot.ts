// Bounded offline replay of archived duplicate-sale decisions. No model or RPC traffic.
// This is not a closed-loop recovery experiment: stop at the first changed send.
// bun --conditions=eliza-source replay-pilot.ts <folders...> --out=<fresh dir> [--evidence-module=<path>]
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const arg = (key: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3);
const folders = process.argv.slice(2).filter(x => !x.startsWith('--')).map(x => resolve(x));
const out = arg('out');
if (!out || !folders.length) throw new Error('Pass result folders and --out=<fresh directory>');
if (existsSync(out)) throw new Error('Replay output already exists; never overwrite');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const modulePath = resolve(arg('evidence-module') ?? join(import.meta.dir, '../../plugins/plugin-wallet/src/chains/evm/evidence.ts'));
// Deliberately reject accidental network use by imported code or future changes.
globalThis.fetch = async () => { throw new Error('Offline replay forbids network access'); };
const evidence = await import(modulePath);
process.env.EVM_EVIDENCE_ABLATE = 'none';

function candidate(m: any, ep: any) {
  if (m.condition !== 'stock' || ep.scenario !== 'rpc_stale' || !ep.outcome.duplicateSale) return null;
  const sales = new Set(ep.outcome.transactions.filter((t: any) => t.status === 'success' && BigInt(t.effectiveValue) > 0n && t.effectiveTo === m.frozen.router.toLowerCase()).map((t: any) => t.hash));
  const sends = ep.forkJournal.filter((j: any) => j.event === 'send' && j.from === m.sender.toLowerCase() && sales.has(j.hash));
  const first = sends.find((j: any) => j.sale);
  const retry = sends.find((j: any) => j !== first && j.hash !== first?.hash);
  if (!first || !retry || !first.data || !retry.data) return null;
  const state = ep.faultState;
  if (!state || state.lagBlock !== first.saleBlock - 1 || retry.at >= state.lagUntil || retry.at <= first.at || retry.at - first.at < 60_000) return null;
  const describe = (send: any) => evidence.describeCall({chainId: 1, sender: m.sender, holder: m.holder, to: send.to, value: BigInt(send.value), data: send.data});
  const intent = describe(first), retryIntent = describe(retry);
  if (evidence.intentKey(intent) !== evidence.intentKey(retryIntent)) return null;
  const before = ep.outcome.before;
  if (intent.effect?.kind !== 'balance_increase' || intent.effect.token.toLowerCase() !== m.frozen.x.address.toLowerCase() || intent.effect.holder.toLowerCase() !== m.holder.toLowerCase()) return null;
  const originalIndex = ep.forkJournal.indexOf(first);
  if (!Number.isInteger(before.nonce) || ep.forkJournal.slice(0, originalIndex).some((j: any) => j.event === 'send' && j.from === m.sender.toLowerCase())) return null;
  return {first, retry, state, intent, before};
}

async function replay(m: any, ep: any, c: any) {
  evidence.resetEvidenceLedgers();
  let now = c.first.at;
  const nonces: number[] = [];
  let stopped = false;
  // Reconstruct ONLY the lagging window defined by the recorded proxy fault.
  // No future final balance, receipt or head is supplied to the policy.
  const pub = {
    getTransactionCount: async () => c.before.nonce,
    getTransaction: async () => { throw new Error('not found in lagging view'); },
    getTransactionReceipt: async () => { throw new Error('receipt absent in lagging view'); },
    getBlockNumber: async () => BigInt(c.state.lagBlock),
    getBlock: async () => { throw new Error('no visible receipt block'); },
    getBalance: async () => 0n,
    readContract: async () => 0n,
  };
  if (Number(c.before.x) !== 0) throw new Error('Replay currently requires the pilot zero-X initial state');
  const wallet = {
    prepareTransactionRequest: async (request: any) => ({...request, gas: 300000n, gasPrice: 100n}),
    sendTransaction: async (request: any) => {
      nonces.push(request.nonce);
      if (nonces.length === 1) return c.first.hash;
      // Do not fabricate a replacement hash or node response; stop at divergence.
      if (request.data !== c.first.data || request.to.toLowerCase() !== c.first.to || request.value !== BigInt(c.first.value)) throw new Error('Stored request changed');
      stopped = true;
      throw new Error('STOP_AT_FIRST_COUNTERFACTUAL_SEND');
    },
  };
  const options = {walletClient: wallet, publicClient: pub, request: {account: {address: m.sender}, to: c.first.to, data: c.first.data, value: BigInt(c.first.value)}, intent: c.intent,
    deps: {now: () => now, sleep: async (ms: number) => { now += ms; if (now >= c.state.lagUntil) throw new Error('Outside supported observation window'); }}};
  let firstDecision: string | null = null;
  try { await evidence.sendWithEvidence(options); throw new Error('Stale first send unexpectedly confirmed'); }
  catch (e: any) { if (e.code !== 'EVIDENCE_PENDING') throw e; firstDecision = e.data.evidence.decision; }
  if (now > c.retry.at) throw new Error('Recorded retry precedes reconstructed first check budget');
  now = c.retry.at;
  try { await evidence.sendWithEvidence(options); }
  catch (e: any) { if (!stopped || !String(e.message).includes('STOP_AT_FIRST_COUNTERFACTUAL_SEND')) throw e; }
  if (!stopped || nonces.length !== 2 || nonces[0] !== c.before.nonce || nonces[1] !== nonces[0]) throw new Error('Pinned-nonce replay failed');
  return {id: ep.id, scenario: ep.scenario, originalCanonicalSales: ep.outcome.successfulSales, originalInitialNonce: c.before.nonce,
    replayAttemptedNonces: nonces, originalRetryDelaySeconds: (c.retry.at - c.first.at) / 1000,
    lagBlock: c.state.lagBlock, lagUntil: c.state.lagUntil, firstDecision,
    verdict: 'fresh_nonce_duplicate_prevented_for_this_recorded_open_intent',
    scope: 'first changed send only; no counterfactual completion, latency, gas, BDT, PAF or IVL claimed'};
}

const inputs: Record<string, string> = {};
const results: any[] = [];
const normal: any[] = [];
const negative: any[] = [];
let episodes = 0;
for (const folder of folders) {
  const mp = join(folder, 'manifest.json'), cp = join(folder, 'complete.json');
  const m = read(mp), complete = read(cp);
  if (complete.mode !== m.mode || existsSync(join(folder, 'run-error.json'))) throw new Error('Need a completed cohort');
  inputs[mp] = sha(mp); inputs[cp] = sha(cp);
  for (const name of readdirSync(join(folder, 'episodes')).filter(x => x.endsWith('.json') && !x.startsWith('control-'))) {
    const p = join(folder, 'episodes', name), ep = read(p); inputs[p] = sha(p); episodes++;
    if (ep.scenario === 'normal') normal.push({id: ep.id, chainGoal: ep.outcome.goalReached,
      falseHold: null, classification: 'not_identifiable_from_recorded_closed_loop',
      reason: 'No complete time-resolved canonical-block/effect observations under the alternative policy; intended K-confirmation waits are not false holds.'});
    const c = candidate(m, ep);
    if (c) {
      results.push(await replay(m, ep, c));
      const changed = structuredClone(ep);
      const later = changed.forkJournal.find((j: any) => j.event === 'send' && j.hash === c.retry.hash);
      later.value = (BigInt(later.value) * 2n).toString();
      if (candidate(m, changed)) throw new Error('Negative different-intent case accepted');
      negative.push({id: ep.id, test: 'different amount cannot inherit same-intent claim', rejected: true});
      const late = structuredClone(ep);
      late.forkJournal.find((j: any) => j.event === 'send' && j.hash === c.retry.hash).at = c.state.lagUntil + 1;
      if (candidate(m, late)) throw new Error('Negative expired-window case accepted');
      negative.push({id: ep.id, test: 'outside stale window cannot inherit unresolved claim', rejected: true});
    } else if (ep.outcome.duplicateSale) results.push({id: ep.id, scenario: ep.scenario, verdict: 'unsupported_or_indeterminate', scope: 'No replay protection claim'});
  }
}
mkdirSync(out, {recursive: true});
writeFileSync(join(out, 'replay.json'), JSON.stringify({kind: 'bounded_offline_replay', episodes, modulePath, moduleSha256: sha(modulePath), results, normal, negative}, null, 2));
writeFileSync(join(out, 'input-sha256.json'), JSON.stringify(inputs, null, 2));
const supported = results.filter(x => x.verdict.startsWith('fresh_nonce')).length;
writeFileSync(join(out, 'report.md'), `# Bounded offline pilot replay\n\n${episodes} archived model episodes inspected. ${supported} recorded duplicate-sale decisions replayed through the actual fixed evidence module; ${negative.length} negative cases rejected. No model/RPC traffic.\n\nThe first changed send reused the initial nonce and calldata in every supported case. This is the standard nonce-pinning safety anchor, not evidence that grading uniquely prevents duplicates. A competent nonce-pinning baseline should share it. The archived retry is presented conditionally; it is not claimed that a live agent would still choose it after changed feedback. No later model behaviour, task completion or counterfactual financial loss is inferred.\n\n${normal.length} normal episodes were inspected; their counterfactual false-hold rate is **not identifiable** from these traces. Missing policy-specific observations are not filled using final chain state. Closed-loop normal mocks and later approved live comparisons are required.\n\nInputs and evidence-module hash are retained alongside replay.json. Observations inside the stale window are reconstructed from the recorded proxy semantics; gas/fees are placeholders, not a signed-packet replay. The first policy call is allowed its frozen 60-second check budget; the tool stops at the original retry's changed send.\n`);
console.log(JSON.stringify({episodes,supportedDuplicateReplays:supported,negativeCasesRejected:negative.length,normalFalseHoldIndeterminate:normal.length,networkCalls:0,out}));
