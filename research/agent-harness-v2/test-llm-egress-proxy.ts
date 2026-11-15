// Offline tests for llm-egress-proxy.ts against a local fake provider. No network model calls.
// Copied from the Spartan harness (c47d7c3) and extended for the v2 proxy (Chat Completions, SSE, local embeddings).
// Usage: bun test-llm-egress-proxy.ts
import {mkdtempSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const seen: any[] = [];
const fake = Bun.serve({port: 18661, hostname: '127.0.0.1', async fetch(req) {
  const body = await req.json(); seen.push({path: new URL(req.url).pathname, auth: req.headers.get('authorization'), xkey: req.headers.get('x-api-key'), body});
  if (JSON.stringify(body).includes('FAIL500')) return Response.json({error: {message: 'upstream failure'}}, {status: 500});
  const path = new URL(req.url).pathname;
  const sse = (events: string[]) => new Response(events.join(''), {headers: {'content-type': 'text/event-stream'}});
  if (path.endsWith('/chat/completions') && body.stream) return sse([
    `data: ${JSON.stringify({choices: [{index: 0, delta: {role: 'assistant', content: 'ok'}, finish_reason: null}]})}\n\n`,
    `data: ${JSON.stringify({choices: [], usage: {prompt_tokens: 3000, completion_tokens: 300, total_tokens: 3300}})}\n\n`, 'data: [DONE]\n\n']);
  if (path.endsWith('/chat/completions')) return Response.json({id: 'c', object: 'chat.completion', model: body.model,
    choices: [{index: 0, message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200}});
  if (path.endsWith('/messages') && body.stream) return sse([
    `event: message_start\ndata: ${JSON.stringify({type: 'message_start', message: {usage: {input_tokens: 40, cache_read_input_tokens: 10, output_tokens: 1}}})}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 5}})}\n\n`]);
  if (path.endsWith('/messages')) return Response.json({id: 'm', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
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
check('a budget refusal keeps no reservation', !('reservationUSD' in L[3]) && L[3].wouldReserveUSD > 0);
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

// v2: Chat Completions (JSON and SSE), Anthropic SSE, and local embeddings.
const c = await proxy(18675, ['--cohort-cap-usd=1', '--cumulative-cap-usd=1', '--prior-usd=0']);
const nBefore = seen.length;
r = await post(`${c.url}/openai/v1/embeddings`, {model: 'text-embedding-3-small', input: ['alpha beta', 'gamma']});
const emb: any = await r.json();
check('embeddings answered locally, outside a turn, never forwarded', r.status === 200 && seen.length === nBefore && emb.data.length === 2 && emb.data[0].embedding.length === 1536);
await post(`${c.url}/control/turn`, {episodeId: 'luna-v2-r1-normal', turn: 0});
r = await post(`${c.url}/openai/v1/chat/completions`, {model: 'gpt-6-luna', messages: [{role: 'user', content: 'hi'}], max_tokens: 100});
check('gpt-6 chat request without tools is not given reasoning_effort', !('reasoning_effort' in seen[seen.length - 1].body));
r = await post(`${c.url}/openai/v1/chat/completions`, {model: 'gpt-6-luna', messages: [{role: 'user', content: 'hi'}], stream: true, stream_options: {include_usage: true}, max_tokens: 100});
const sseText = await r.text();
r = await post(`${c.url}/anthropic/v1/messages`, {model: 'claude-haiku-5-5', max_tokens: 100, stream: true, messages: [{role: 'user', content: 'hi'}]}, {'anthropic-version': '2023-06-01'});
r = await post(`${c.url}/openai/v1/chat/completions`, {model: 'gpt-6-luna', messages: [{role: 'user', content: 'hi'}], tools: [{type: 'function', function: {name: 'T', parameters: {type: 'object'}}}], max_tokens: 100});
check('gpt-6 chat request with tools is forwarded with reasoning_effort none', seen[seen.length - 1].body.reasoning_effort === 'none');
const C = ledger(c.dest).slice(0, 4);
check('tool request records the normalization', JSON.stringify(ledger(c.dest)[4].normalized) === JSON.stringify(['reasoning_effort:none']));
check('ledger: local embedding, then three settled calls', JSON.stringify(C.map(e => e.status)) === JSON.stringify(['local_embedding', 'settled', 'settled', 'settled']));
check('chat completions cost from prompt/completion tokens: 2000*0.125 + 200*0.5 per M', Math.abs(C[1].estimatedUSD - (2000 * 0.125 + 200 * 0.5) / 1e6) < 1e-15);
check('openai SSE passed through and settled from the usage chunk: 3000*0.125 + 300*0.5 per M', sseText.includes('[DONE]') && Math.abs(C[2].estimatedUSD - (3000 * 0.125 + 300 * 0.5) / 1e6) < 1e-15);
check('anthropic SSE settled from message_start + message_delta: (40+10)*0.10 + 5*0.50 per M', Math.abs(C[3].estimatedUSD - (50 * 0.10 + 5 * 0.5) / 1e6) < 1e-15);
c.p.kill();

// The test upstream override is refused for non-temp folders.
const bad = Bun.spawnSync([process.execPath, join(import.meta.dir, 'llm-egress-proxy.ts'), '--port=18673', `--dest=${join(import.meta.dir, 'should-not-exist')}`, '--mode=live',
  '--test-upstream=http://127.0.0.1:18661', '--cohort-cap-usd=1', '--cumulative-cap-usd=1'], {env: {PATH: process.env.PATH ?? '', TMPDIR: tmpdir()}});
check('test upstream refused outside temp folders', bad.exitCode !== 0);
// visible-financial-results-v1: replay actual agent-visible histories through the HTTP proxy.
// Failure fixture: gate3 random seed 10; positive fixtures: real ElizaOS, agent2 and MCP normal tool claims.
// Fixtures contain only the user's task and assistant tool calls/results, never outcomes, scenario or arm fields.
const visible = (name: string): any[] => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', `mock-visible-${name}.json`), 'utf8'));
const clone = (x: any) => JSON.parse(JSON.stringify(x));
function messagesFor(messages: any[], provider: string): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (provider === 'anthropic' && m.tool_calls) {
      out.push({role: 'assistant', content: m.tool_calls.map((t: any) => ({type: 'tool_use', id: t.id,
        name: t.function.name, input: JSON.parse(t.function.arguments)}))});
    } else if (provider === 'anthropic' && m.role === 'tool') {
      out.push({role: 'user', content: [{type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content}]});
    } else if (provider === 'openai' && Array.isArray(m.content)) {
      for (const x of m.content) {
        if (x.type === 'tool_use') out.push({role: 'assistant', content: null, tool_calls: [{id: x.id, type: 'function',
          function: {name: x.name, arguments: JSON.stringify(x.input)}}]});
        else if (x.type === 'tool_result') out.push({role: 'tool', tool_call_id: x.tool_use_id,
          content: typeof x.content === 'string' ? x.content : JSON.stringify(x.content)});
      }
    } else out.push(clone(m));
  }
  return out;
}
function financialCalls(messages: any[]) {
  const out: any[] = [];
  for (const m of messagesFor(messages, 'openai')) for (const t of m.tool_calls ?? [])
    out.push({tool: t.function.name, args: JSON.parse(t.function.arguments)});
  return [...new Map(out.map(x => [JSON.stringify(x), x])).values()];
}
const mockDir = mkdtempSync(join(tmpdir(), 'mock-visible-proof-'));
const mockProc = Bun.spawn([process.execPath, join(import.meta.dir, 'llm-egress-proxy.ts'), '--port=18678', `--dest=${mockDir}`, '--mode=mock'],
  {env: {PATH: process.env.PATH ?? '', TMPDIR: tmpdir()}, stdout: 'ignore', stderr: 'inherit'});
const mockUrl = 'http://127.0.0.1:18678';
for (let i = 0; i < 100; i++) { try { await fetch(`${mockUrl}/control/ledger`); break; } catch { await Bun.sleep(50); } }
let mockEpisode = 0;
const finalShape = (provider: string, kind: string) => {
  const name = kind === 'stage1' ? 'HANDLE_RESPONSE' : 'REPLY';
  const schema = {type: 'object', properties: {[kind === 'stage1' ? 'replyText' : 'text']: {type: 'string'}},
    required: [kind === 'stage1' ? 'replyText' : 'text']};
  return kind === 'text' ? [] : provider === 'openai' ? [{type: 'function', function: {name, parameters: schema}}]
    : [{name, input_schema: schema}];
};
async function mockRequest(provider: string, messages: any[], kind = 'text') {
  const response = await post(`${mockUrl}/${provider}/v1/${provider === 'openai' ? 'chat/completions' : 'messages'}`,
    {model: provider === 'openai' ? 'gpt-6-luna' : 'claude-haiku-5-5', max_tokens: 100,
      messages: messagesFor(messages, provider), tools: finalShape(provider, kind)});
  assert.equal(response.status, 200);
  const body: any = await response.json();
  if (provider === 'openai') {
    const m = body.choices[0].message;
    return m.tool_calls ? Object.values(JSON.parse(m.tool_calls[0].function.arguments))[0] : m.content;
  }
  const c = body.content[0]; return c.type === 'tool_use' ? Object.values(c.input)[0] : c.text;
}
async function beginMock(required: any, declared = 'COMPLETED', extra: any = {}) {
  await post(`${mockUrl}/control/turn`, {episodeId: `visible-proof-${++mockEpisode}`, turn: 0, turnKind: 'task', resetMock: true,
    mockPlan: {calls: [], declared, ...(required === undefined ? {} : {requiredFinancialActions: required})}, ...extra});
}
async function closeMock(provider: string, required: any, kind = 'text') {
  await post(`${mockUrl}/control/idle`, {});
  await post(`${mockUrl}/control/turn`, {episodeId: `visible-proof-${mockEpisode}`, turn: 1, turnKind: 'closing',
    mockPlan: {calls: [], declared: 'COMPLETED', ...(required === undefined ? {} : {requiredFinancialActions: required})}});
  return mockRequest(provider, [{role: 'user', content: 'Report whether my original task is complete.'}], kind);
}
try {
  for (const provider of ['openai', 'anthropic']) {
    const applied = visible('applied'), required = financialCalls(applied);
    await beginMock(required); await mockRequest(provider, visible('failure'));
    check(`${provider}: recorded failed approval remains IN_PROGRESS across idle/closing without tool history`, await closeMock(provider, required) === 'IN_PROGRESS');
    for (const kind of ['stage1', 'reply', 'text']) {
      await beginMock(required); await mockRequest(provider, applied);
      check(`${provider}: actual applied Eliza financial claims permit COMPLETED via ${kind}`, await closeMock(provider, required, kind) === 'COMPLETED');
    }
    for (const name of ['direct', 'mcp']) {
      const messages = visible(name), need = financialCalls(messages);
      await beginMock(need); await mockRequest(provider, messages);
      check(`${provider}: actual ${name} receipt success/hash/block permits COMPLETED`, await closeMock(provider, need) === 'COMPLETED');
    }
    const finalIndex = applied.findLastIndex(m => m.role === 'tool');
    const finalCall = applied[finalIndex - 1].tool_calls[0];
    const finalResult = JSON.parse(applied[finalIndex].content);
    const hash = finalResult.data.transactionHash;
    const pending = {success: false, data: {error: 'EVIDENCE_PENDING', evidence: {hashes: [hash], pinnedNonce: 8}}};
    const recover = clone(applied);
    recover[finalIndex].content = JSON.stringify(pending);
    const call = clone(finalCall); call.id = 'visible-recovery';
    const args = JSON.parse(call.function.arguments); args.amount = String(args.amount).includes('.') ? `${args.amount}0` : `${args.amount}.0`; call.function.arguments = JSON.stringify(args);
    recover.push({role: 'assistant', content: null, tool_calls: [call]}, {role: 'tool', tool_call_id: call.id, content: JSON.stringify(finalResult)});
    await beginMock(required); await mockRequest(provider, recover);
    check(`${provider}: later explicit same-hash recovery clears pending same-operation attempt`, await closeMock(provider, required) === 'COMPLETED');
    const ambiguous = clone(recover); const first = JSON.parse(ambiguous[finalIndex].content);
    first.data.evidence.hashes = ['0x' + 'a'.repeat(64)]; ambiguous[finalIndex].content = JSON.stringify(first);
    await beginMock(required); await mockRequest(provider, ambiguous);
    check(`${provider}: new-hash success without same-nonce proof cannot erase ambiguous earlier attempt`, await closeMock(provider, required) === 'IN_PROGRESS');
    const pinned = clone(ambiguous); const last = JSON.parse(pinned.at(-1).content);
    last.data.pinnedNonce = 8; pinned.at(-1).content = JSON.stringify(last);
    await beginMock(required); await mockRequest(provider, pinned);
    check(`${provider}: explicit same-pinned-nonce recovery can clear an ambiguous replacement`, await closeMock(provider, required) === 'COMPLETED');
    const corrupted = clone(applied); const missingReceipt = JSON.parse(corrupted[finalIndex].content); delete missingReceipt.effectReceipts;
    corrupted[finalIndex].content = JSON.stringify(missingReceipt);
    await beginMock(required); await mockRequest(provider, corrupted);
    check(`${provider}: bare submitted/hash or wallet success without an applied receipt stays IN_PROGRESS`, await closeMock(provider, required) === 'IN_PROGRESS');
    await beginMock(undefined); await mockRequest(provider, applied);
    check(`${provider}: missing public-task action contract fails closed`, await closeMock(provider, undefined) === 'IN_PROGRESS');
    const saleOnly = applied.slice(0, 5);
    await beginMock(required, 'INFEASIBLE'); await mockRequest(provider, saleOnly);
    check(`${provider}: sale-only recipe cannot infer infeasibility or completion of the missing goal action`, await closeMock(provider, required) === 'IN_PROGRESS');
    for (const declared of ['INFEASIBLE', 'IN_PROGRESS', 'COMPLETED']) {
      await beginMock(required, declared, {scheduleSeed: 999, arm: 'arbitrary', condition: 'arbitrary'}); await mockRequest(provider, applied);
      check(`${provider}: actual visible proof is independent of scripted declaration ${declared}`, await closeMock(provider, required) === 'COMPLETED');
    }
    await beginMock(required); await mockRequest(provider, applied.slice(0, 3));
    check(`${provider}: confirmation proposal and plan progress are not an applied effect`, await closeMock(provider, required) === 'IN_PROGRESS');
    const quoted = clone(visible('failure'));
    quoted.push({role: 'assistant', content: null, tool_calls: [{id: 'read-after-failure', type: 'function',
      function: {name: 'get_balances', arguments: '{}'}}]},
      {role: 'tool', tool_call_id: 'read-after-failure', content: JSON.stringify({success: true, data: {available: '999'}})});
    await beginMock(required); await mockRequest(provider, quoted);
    check(`${provider}: unrelated read success does not clear a failed financial step`, await closeMock(provider, required) === 'IN_PROGRESS');
    const statusHistory = (status: any) => [...clone(applied), {role: 'assistant', content: null,
      tool_calls: [{id: 'visible-status', type: 'function', function: {name: 'tx_status', arguments: JSON.stringify({hash})}}]},
      {role: 'tool', tool_call_id: 'visible-status', content: JSON.stringify({success: true, data: {hash, ...status}})}];
    await beginMock(required); await mockRequest(provider, statusHistory({status: 'pending'}));
    check(`${provider}: a later pending status invalidates a cached applied claim`, await closeMock(provider, required) === 'IN_PROGRESS');
    await beginMock(required); await mockRequest(provider, statusHistory({status: 'orphaned', evidence: {state: 'orphaned', hashes: [hash], pinnedNonce: 8}}));
    check(`${provider}: a later visible orphan invalidates a cached applied claim`, await closeMock(provider, required) === 'IN_PROGRESS');
    const differentNonce = clone(ambiguous); const other = JSON.parse(differentNonce.at(-1).content);
    other.data.pinnedNonce = 9; differentNonce.at(-1).content = JSON.stringify(other);
    await beginMock(required); await mockRequest(provider, differentNonce);
    check(`${provider}: a distinct nonce cannot reconcile the earlier ambiguous dispatch`, await closeMock(provider, required) === 'IN_PROGRESS');
    const duplicate = clone(applied), duplicateCall = clone(finalCall); duplicateCall.id = 'visible-second-applied';
    const duplicateResult = clone(finalResult); duplicateResult.data.transactionHash = '0x' + 'b'.repeat(64);
    for (const receipt of duplicateResult.effectReceipts) receipt.resource.id = duplicateResult.data.transactionHash;
    duplicate.push({role: 'assistant', content: null, tool_calls: [duplicateCall]},
      {role: 'tool', tool_call_id: duplicateCall.id, content: JSON.stringify(duplicateResult)});
    await beginMock(required); await mockRequest(provider, duplicate);
    check(`${provider}: two distinct applied transaction claims for one task leg do not prove exactly once`, await closeMock(provider, required) === 'IN_PROGRESS');
    await beginMock(required); await mockRequest(provider, []);
    check(`${provider}: unknown evidence does not prove completion`, await closeMock(provider, required) === 'IN_PROGRESS');
    await beginMock(required); await mockRequest(provider, applied);
    await post(`${mockUrl}/control/turn`, {episodeId: 'different-episode', turn: 0, turnKind: 'closing', mockPlan: {calls: [], declared: 'COMPLETED', requiredFinancialActions: required}});
    check(`${provider}: changing episode without resetMock cannot inherit old completion proof`, await mockRequest(provider, []) === 'IN_PROGRESS');
  }
} finally { mockProc.kill(); }
fake.stop(true);
console.log(results.join('\n'));
