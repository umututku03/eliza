// Copied from the Spartan harness (umututku03/spartan-agent c47d7c3, research/agent-flow-cohorts/llm-egress-proxy.ts).
// LLM egress proxy for the real-agent cohorts. Runs as its own process; it is the only process that
// holds provider API keys. The agent's model plugins point their base URLs here with a placeholder key.
//
//   /openai/v1/*    -> https://api.openai.com/v1/*      (plugin-openai, Responses API)
//   /anthropic/v1/* -> https://api.anthropic.com/v1/*   (plugin-anthropic, Messages API)
//   /control/*      -> episode/turn context, mock plan, ledger (local only)
//
// Every model call is saved (request body after normalization, response body, usage) without headers.
// Calls outside an active episode turn are refused, so background tasks cannot spend budget. The only
// request normalization is removing `temperature` for gpt-6* models, which reject it (see
// plugin-compat-probe.json); each removal is recorded on the call.
//
// Usage: bun llm-egress-proxy.ts --port=18650 --dest=<dir> --mode=live|mock [--cohort-cap-usd=N --cumulative-cap-usd=N --prior-usd=N]
import {mkdirSync, writeFileSync, appendFileSync, existsSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const port = Number(arg('port') ?? 18650);
const dest = arg('dest');
const mode = arg('mode') ?? 'mock';
if (!dest || !['live', 'mock'].includes(mode)) throw new Error('Pass --dest=<dir> and --mode=live|mock.');
const priorUSD = Number(arg('prior-usd') ?? 0);
const cohortCap = mode === 'live' ? Number(arg('cohort-cap-usd')) : Infinity;
const cumulativeCap = mode === 'live' ? Number(arg('cumulative-cap-usd')) : Infinity;
if (mode === 'live' && !(cohortCap > 0 && cumulativeCap > priorUSD)) throw new Error('Live mode needs approved caps.');
if (mode === 'live' && existsSync(join(dest, 'calls'))) throw new Error('Refusing to overwrite an existing call record.');
// The test-only upstream override is refused unless the record folder already exists inside the OS temp
// directory, so it can never apply to a real cohort run.
const testUpstream = arg('test-upstream');
if (testUpstream && !(existsSync(dest) && realpathSync(dest).startsWith(realpathSync(tmpdir())))) throw new Error('--test-upstream is only allowed for temp test folders');
mkdirSync(join(dest, 'calls'), {recursive: true});

// Upstream prices, USD per million tokens. Input is settled at the higher of the input and cache-write
// rates (cache writes cost 1.25x on GPT-6.x when automatic caching applies), an upper bound.
export const PRICES: Record<string, {input: number; output: number; cacheWriteFactor: number}> = {
  'gpt-6-luna': {input: 0.10, output: 0.50, cacheWriteFactor: 1.25},
  'gpt-6.1-sol': {input: 2, output: 10, cacheWriteFactor: 1.25},
  'claude-haiku-5-5': {input: 0.10, output: 0.50, cacheWriteFactor: 1},
  'claude-opus-5-5': {input: 4, output: 20, cacheWriteFactor: 1},
};
const UPSTREAM: Record<string, string> = {openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com'};
// Test-only fake provider (test-llm-egress-proxy.ts); validated before any folder is created.
if (testUpstream) { UPSTREAM.openai = testUpstream; UPSTREAM.anthropic = testUpstream; }

let context: any = null;            // {episodeId, turn, mockPlan?} while a turn is active
let mockState: any = {step: 0};
let calls = 0, usedUSD = priorUSD;
const ledgerPath = join(dest, 'ledger.jsonl');

function promptText(provider: string, body: any): string {
  const parts: string[] = [];
  const walk = (x: any) => {
    if (typeof x === 'string') parts.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (k === 'text' || k === 'content' || k === 'input' || k === 'system' || k === 'instructions') walk(v);
  };
  walk(provider === 'openai' ? {instructions: body.instructions, input: body.input} : {system: body.system, content: body.messages});
  return parts.join('\n');
}

// Scripted stand-in for dry runs. Chooses outputs from the runner-supplied plan, never from model inference.
const CLOSING_MARKER = 'reply with exactly one word';
function mockOutput(text: string): {kind: string; out: string} {
  const plan = context?.mockPlan ?? {steps: [], declared: 'IN_PROGRESS'};
  const step = plan.steps[mockState.step];
  const lower = text.toLowerCase();
  const closing = lower.includes(CLOSING_MARKER); // the closing question is always the final user message
  if (text.includes('<facts>')) return {kind: 'reflection', out: '<response><thought>noted</thought><facts></facts><relationships></relationships></response>'};
  if (text.includes('<message>Your message here</message>')) return {kind: 'reply', out: `<response><thought>reply</thought><message>${closing ? plan.declared : 'Working on it.'}</message></response>`};
  if (text.includes('Your final message to the user')) return {kind: 'summary', out: `<response><thought>summary</thought><text>${closing ? plan.declared : 'Done with the planned steps.'}</text></response>`};
  if (text.includes('<isFinish>')) {
    if (closing || !step || step.action === 'REPLY') return {kind: 'decision', out: '<response><thought>finished</thought><action></action><providers></providers><isFinish>true</isFinish></response>'};
    mockState.step++;
    return {kind: 'decision', out: `<response><thought>next step</thought><action>${step.action}</action><providers></providers><isFinish>false</isFinish></response>`};
  }
  if (text.includes('<actions>')) {
    if (closing) return {kind: 'handler', out: `<response><thought>status</thought><actions>REPLY</actions><providers></providers><text>${plan.declared}</text></response>`};
    if (!step || step.action === 'REPLY') { if (step) mockState.step++; return {kind: 'handler', out: `<response><thought>reply</thought><actions>REPLY</actions><providers></providers><text>${step?.text ?? 'Nothing more to do.'}</text></response>`}; }
    mockState.step++;
    return {kind: 'handler', out: `<response><thought>act</thought><actions>${step.action}</actions><providers></providers><text>Executing.</text></response>`};
  }
  return {kind: 'other', out: '<response><thought>ok</thought><text>ok</text></response>'};
}
// The extraction call happens after the handler advanced the pointer: look one step back for its swap.
function mockExtract(text: string) {
  const plan = context?.mockPlan ?? {steps: []};
  const step = plan.steps[mockState.step - 1];
  return step?.swap ? JSON.stringify(step.swap) : '{}';
}

function mockResponse(provider: string, model: string, text: string, n: number) {
  let {kind, out} = mockOutput(text);
  if (text.includes('"inputTokenSymbol"')) { kind = 'extract'; out = mockExtract(text); }
  const usage = {input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(out.length / 4)};
  if (provider === 'openai') return {kind, body: {id: `resp_mock_${n}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model,
    output: [{type: 'message', id: `msg_mock_${n}`, role: 'assistant', status: 'completed', content: [{type: 'output_text', text: out, annotations: []}]}],
    usage: {...usage, total_tokens: usage.input_tokens + usage.output_tokens}}};
  return {kind, body: {id: `msg_mock_${n}`, type: 'message', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{type: 'text', text: out}], usage}};
}

function settle(provider: string, model: string, usage: any) {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model}`);
  const input = provider === 'openai' ? usage?.input_tokens : (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  const output = usage?.output_tokens;
  if (!Number.isInteger(input) || !Number.isInteger(output)) throw new Error('Missing usage');
  return {input, output, usd: (input * p.input * p.cacheWriteFactor + output * p.output) / 1e6};
}

function reservation(model: string, bodyBytes: number, maxOut: number) {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model}`);
  // Input tokens are bounded by request bytes (+512); output (incl. reasoning) by the request's limit.
  return ((bodyBytes + 512) * p.input * p.cacheWriteFactor + maxOut * p.output) / 1e6;
}

Bun.serve({
  port, hostname: '127.0.0.1', idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/control/')) {
      if (url.pathname === '/control/turn' && req.method === 'POST') { context = await req.json(); if (context.resetMock) mockState = {step: 0}; return Response.json({ok: true}); }
      if (url.pathname === '/control/idle') { context = null; return Response.json({ok: true}); }
      if (url.pathname === '/control/ledger') return Response.json({mode, calls, priorUSD, usedUSD, newUSD: usedUSD - priorUSD, cohortCap, cumulativeCap});
      return new Response('unknown control', {status: 404});
    }
    const provider = url.pathname.startsWith('/openai/') ? 'openai' : url.pathname.startsWith('/anthropic/') ? 'anthropic' : null;
    if (!provider || req.method !== 'POST') return new Response('not allowed', {status: 403});
    const raw = await req.text();
    const body = JSON.parse(raw);
    const n = ++calls;
    const entry: any = {call: n, at: new Date().toISOString(), provider, path: url.pathname, model: body.model,
      episodeId: context?.episodeId ?? null, turn: context?.turn ?? null, normalized: [] as string[]};
    if (!context) {
      entry.status = 'refused_outside_turn';
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: no active episode turn.'}}, {status: 503});
    }
    if (provider === 'openai' && String(body.model).startsWith('gpt-6') && 'temperature' in body) { delete body.temperature; entry.normalized.push('temperature'); }
    const sent = JSON.stringify(body);
    // v2 blinding gate: refuse (never forward, never charge) any request containing a harness label or this
    // episode's identifiers, as supplied by the runner for the active turn.
    const lowered = sent.toLowerCase();
    const leaked = (context.forbidden ?? []).filter((t: string) => t && lowered.includes(String(t).toLowerCase()));
    if (leaked.length) {
      entry.status = 'refused_blinding'; entry.leakedTerms = leaked;
      writeFileSync(join(dest, 'calls', `${n}-request.json`), JSON.stringify({...entry, body}, null, 2));
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: request failed the blinding check.'}}, {status: 503});
    }
    const maxOut = Number(body.max_output_tokens ?? body.max_tokens ?? 8192);
    entry.requestBytes = Buffer.byteLength(sent);
    entry.maxOutputTokens = maxOut;
    writeFileSync(join(dest, 'calls', `${n}-request.json`), JSON.stringify({...entry, body}, null, 2));
    if (mode === 'mock') {
      const text = promptText(provider, body);
      const {kind, body: out} = mockResponse(provider, body.model, text, n);
      entry.mockKind = kind; entry.status = 'mock'; entry.estimatedUSD = 0;
      writeFileSync(join(dest, 'calls', `${n}-response.json`), JSON.stringify({httpStatus: 200, body: out}, null, 2));
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json(out);
    }
    const reserved = reservation(body.model, entry.requestBytes, maxOut);
    if (usedUSD + reserved > cumulativeCap || usedUSD + reserved - priorUSD > cohortCap) {
      entry.status = 'refused_budget'; entry.reservationUSD = reserved;
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: approved budget exhausted.'}}, {status: 503});
    }
    usedUSD += reserved; entry.reservationUSD = reserved;
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (provider === 'openai') headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    else { headers['x-api-key'] = process.env.ANTHROPIC_API_KEY ?? ''; headers['anthropic-version'] = req.headers.get('anthropic-version') ?? '2023-06-01'; }
    const beta = req.headers.get('anthropic-beta'); if (beta) headers['anthropic-beta'] = beta;
    const started = performance.now();
    let status = 0, text = '';
    try {
      const r = await fetch(UPSTREAM[provider] + url.pathname.replace(/^\/(openai|anthropic)/, '') + url.search, {method: 'POST', headers, body: sent, signal: AbortSignal.timeout(300000)});
      status = r.status; text = await r.text();
    } catch (e) {
      entry.status = 'transport_error_reservation_kept'; entry.error = (e as Error).name;
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Upstream transport failure.'}}, {status: 502});
    }
    entry.httpStatus = status; entry.latencyMs = performance.now() - started;
    let parsed: any = null; try { parsed = JSON.parse(text); } catch {}
    writeFileSync(join(dest, 'calls', `${n}-response.json`), JSON.stringify({httpStatus: status, body: parsed ?? text}, null, 2));
    if (status === 200 && parsed?.usage) {
      try { const s = settle(provider, body.model, parsed.usage); usedUSD += s.usd - reserved; Object.assign(entry, {status: 'settled', inputTokens: s.input, outputTokens: s.output, estimatedUSD: s.usd,
        cachedTokens: parsed.usage?.input_tokens_details?.cached_tokens ?? parsed.usage?.cache_read_input_tokens ?? 0,
        reasoningTokens: parsed.usage?.output_tokens_details?.reasoning_tokens ?? null}); }
      catch { entry.status = 'unsettled_usage_reservation_kept'; }
    } else entry.status = 'http_error_reservation_kept';
    appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
    return new Response(text, {status, headers: {'content-type': 'application/json'}});
  },
});
console.log(JSON.stringify({proxy: 'llm-egress', port, mode, dest}));
