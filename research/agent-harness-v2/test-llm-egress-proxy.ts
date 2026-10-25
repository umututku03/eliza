// Offline tests for llm-egress-proxy.ts against a local fake provider. No network model calls.
// Usage: bun test-llm-egress-proxy.ts
import {mkdtempSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const seen: any[] = [];
const fake = Bun.serve({port: 18661, hostname: '127.0.0.1', async fetch(req) {
  const body = await req.json(); seen.push({path: new URL(req.url).pathname, auth: req.headers.get('authorization'), xkey: req.headers.get('x-api-key'), body});
  if (JSON.stringify(body).includes('FAIL500')) return Response.json({error: {message: 'upstream failure'}}, {status: 500});
  if (new URL(req.url).pathname.endsWith('/messages')) return Response.json({id: 'm', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
    content: [{type: 'text', text: 'ok'}], usage: {input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 20, output_tokens: 10}});
  return Response.json({id: 'r', object: 'response', created_at: 1, status: 'completed', model: body.model, output: [], usage: {input_tokens: 1000, output_tokens: 100, total_tokens: 1100}});
}});

async function proxy(port: number, extra: string[]) {
  const dest = mkdtempSync(join(tmpdir(), 'egress-test-'));
  const p = Bun.spawn([process.execPath, join(import.meta.dir, 'llm-egress-proxy.ts'), `--port=${port}`, `--dest=${dest}`, '--mode=live', '--test-upstream=http://127.0.0.1:18661', ...extra],
    {env: {PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), OPENAI_API_KEY: 'test-openai-key-123', ANTHROPIC_API_KEY: 'test-anthropic-key-456'}, stdout: 'ignore', stderr: 'inherit'});
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/control/ledger`); break; } catch { await Bun.sleep(50); } }
  return {p, dest, url: `http://127.0.0.1:${port}`};
}
const post = (url: string, body: any, headers: any = {}) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
const ledger = (dest: string) => readFileSync(join(dest, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const results: string[] = [];
const check = (name: string, cond: boolean) => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) process.exitCode = 1; };

// OpenAI-shaped proxy with a tiny cap: reservation per call ~ ((bytes+512)*0.125 + 1000*0.5)/1e6 ~ 0.0006
const a = await proxy(18671, ['--cohort-cap-usd=0.0012', '--cumulative-cap-usd=1', '--prior-usd=0']);
let r = await post(`${a.url}/openai/v1/responses`, {model: 'gpt-6-luna', input: 'x', max_output_tokens: 1000});
check('call outside a turn is refused (503) and never forwarded', r.status === 503 && seen.length === 0);
await post(`${a.url}/control/turn`, {episodeId: 'luna-single_shot-stock-normal', turn: 0});
r = await post(`${a.url}/openai/v1/responses`, {model: 'gpt-6-luna', input: 'hello', temperature: 0.7, max_output_tokens: 1000}, {authorization: 'Bearer sk-harness-placeholder'});
check('first call forwarded with 200', r.status === 200);
check('temperature removed for gpt-6 before forwarding', seen.length === 1 && !('temperature' in seen[0].body));
check('real key injected, placeholder never forwarded', seen[0].auth === 'Bearer test-openai-key-123');
r = await post(`${a.url}/openai/v1/responses`, {model: 'gpt-6-luna', input: 'FAIL500', max_output_tokens: 1000});
check('upstream HTTP error is passed through', r.status === 500);
r = await post(`${a.url}/openai/v1/responses`, {model: 'gpt-6-luna', input: 'again', max_output_tokens: 1000});
check('call beyond the approved cap is refused before forwarding', r.status === 503 && seen.length === 2);
let L = ledger(a.dest);
check('ledger statuses in order', JSON.stringify(L.map(e => e.status)) === JSON.stringify(['refused_outside_turn', 'settled', 'http_error_reservation_kept', 'refused_budget']));
check('settled cost = usage x price (1000 in at 0.10x1.25, 100 out at 0.50)', Math.abs(L[1].estimatedUSD - (1000 * 0.125 + 100 * 0.5) / 1e6) < 1e-15);
check('normalization recorded', JSON.stringify(L[1].normalized) === JSON.stringify(['temperature']));
const recs = readdirSync(join(a.dest, 'calls')).map(f => readFileSync(join(a.dest, 'calls', f), 'utf8')).join('\n').toLowerCase();
check('no headers or keys in saved records', !recs.includes('authorization') && !recs.includes('x-api-key') && !recs.includes('test-openai-key-123') && !recs.includes('placeholder'));
a.p.kill();

// v2 blinding gate: a request containing a forbidden term for the active turn is refused and never forwarded.
const g = await proxy(18674, ['--cohort-cap-usd=1', '--cumulative-cap-usd=1', '--prior-usd=0']);
await post(`${g.url}/control/turn`, {episodeId: 'luna-multi_step-stock-receipt_hidden', turn: 0, forbidden: ['receipt_hidden', 'luna-multi_step-stock-receipt_hidden']});
const before = seen.length;
r = await post(`${g.url}/openai/v1/responses`, {model: 'gpt-6-luna', input: 'user email luna-multi_step-stock-receipt_hidden@x', max_output_tokens: 100});
const G = ledger(g.dest);
check('blinding gate refuses a label-bearing request (503), never forwarded, no cost', r.status === 503 && seen.length === before && G[0].status === 'refused_blinding' && !('estimatedUSD' in G[0]));
r = await post(`${g.url}/openai/v1/responses`, {model: 'gpt-6-luna', input: 'clean request', max_output_tokens: 100});
check('clean request in the same turn is forwarded', r.status === 200 && seen.length === before + 1);
g.p.kill();

// Anthropic-shaped settlement includes cache categories in input tokens.
const b = await proxy(18672, ['--cohort-cap-usd=1', '--cumulative-cap-usd=1', '--prior-usd=0']);
await post(`${b.url}/control/turn`, {episodeId: 'opus-single_shot-stock-normal', turn: 0});
r = await post(`${b.url}/anthropic/v1/messages`, {model: 'claude-opus-5-5', max_tokens: 1000, temperature: 0.7, messages: [{role: 'user', content: 'hi'}]}, {'x-api-key': 'sk-ant-harness-placeholder', 'anthropic-version': '2023-06-01'});
L = ledger(b.dest);
check('anthropic request not normalized (SDK already drops temperature for 5.5; proxy changes nothing)', JSON.stringify(L[0].normalized) === '[]' && 'temperature' in seen[seen.length - 1].body);
check('anthropic key injected', seen[seen.length - 1].xkey === 'test-anthropic-key-456');
check('anthropic cost counts cache tokens as input: (100+50+20)*4 + 10*20 per M', Math.abs(L[0].estimatedUSD - (170 * 4 + 10 * 20) / 1e6) < 1e-15);
b.p.kill();

// The test upstream override is refused for non-temp folders.
const bad = Bun.spawnSync([process.execPath, join(import.meta.dir, 'llm-egress-proxy.ts'), '--port=18673', `--dest=${join(import.meta.dir, 'should-not-exist')}`, '--mode=live',
  '--test-upstream=http://127.0.0.1:18661', '--cohort-cap-usd=1', '--cumulative-cap-usd=1'], {env: {PATH: process.env.PATH ?? '', TMPDIR: tmpdir()}});
check('test upstream refused outside temp folders', bad.exitCode !== 0);
fake.stop(true);
console.log(results.join('\n'));
