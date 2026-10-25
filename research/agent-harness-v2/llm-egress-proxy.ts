// LLM egress proxy for the ElizaOS v2 cohorts. Adapted from the Spartan harness (umututku03/spartan-agent
// c47d7c3, research/agent-flow-cohorts/llm-egress-proxy.ts). Changes for v2:
// - OpenAI Chat Completions (what plugin-openai uses) as well as Responses: prompt text and usage read
//   from either shape.
// - Streaming requests: the upstream SSE body is buffered, recorded and returned; usage comes from its events.
// - Embedding requests are answered locally with deterministic vectors: free, never forwarded.
// - A budget refusal keeps no reservation; the verifier must not add one.
// - Mock mode answers v2's native tool-calling prompts from the runner's scripted plan.
//
// Runs as its own process; it is the only process that holds provider API keys.
//   /openai/v1/*    -> https://api.openai.com/v1/*
//   /anthropic/v1/* -> https://api.anthropic.com/v1/*
//   /control/*      -> episode/turn context, mock plan, ledger (local only)
// Every model call is saved (request body after normalization, response body, usage) without headers. Calls
// outside an active episode turn are refused, so background tasks cannot spend budget. Request normalizations,
// each recorded on the call: remove `temperature` for gpt-6* models, which reject it; and for gpt-6* Chat
// Completions requests that carry tools, set `reasoning_effort: "none"`. OpenAI rejects function tools with any
// other reasoning effort on that endpoint ("use /v1/responses or set reasoning_effort to 'none'"), and stock
// plugin-openai never sends "none" to OpenAI, so without this every planner call fails (live-1b, run 1).
//
// Usage: bun llm-egress-proxy.ts --port=18650 --dest=<dir> --mode=live|mock [--cohort-cap-usd=N --cumulative-cap-usd=N --prior-usd=N]
import {mkdirSync, writeFileSync, appendFileSync, existsSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
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
if (testUpstream) { UPSTREAM.openai = testUpstream; UPSTREAM.anthropic = testUpstream; }

let context: any = null;            // {episodeId, turn, turnKind, mockPlan?, forbidden} while a turn is active
let mockState: any = {step: 0, callsThisTurn: 0};
let calls = 0, usedUSD = priorUSD;
const ledgerPath = join(dest, 'ledger.jsonl');

function promptText(body: any): string {
  const parts: string[] = [];
  const walk = (x: any) => {
    if (typeof x === 'string') parts.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (['text', 'content', 'input', 'system', 'instructions', 'messages'].includes(k)) walk(v);
  };
  walk({instructions: body.instructions, input: body.input, system: body.system, messages: body.messages});
  return parts.join('\n');
}

// ---- usage -----------------------------------------------------------------------------------------------
type Usage = {input: number; output: number; cached: number; reasoning: number | null};
/** Usage from a JSON body (Chat Completions, Responses or Messages). */
function usageOf(provider: string, u: any): Usage | null {
  if (!u) return null;
  if (provider === 'openai') {
    const input = u.prompt_tokens ?? u.input_tokens, output = u.completion_tokens ?? u.output_tokens;
    if (!Number.isInteger(input) || !Number.isInteger(output)) return null;
    return {input, output, cached: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? null};
  }
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  if (!Number.isInteger(u.output_tokens)) return null;
  return {input, output: u.output_tokens, cached: u.cache_read_input_tokens ?? 0, reasoning: null};
}
/** Usage from a buffered SSE body: OpenAI's final usage chunk, or Anthropic's message_start + message_delta. */
function usageOfSse(provider: string, text: string): Usage | null {
  const events = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(d => d && d !== '[DONE]')
    .map(d => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean);
  if (provider === 'openai') return usageOf('openai', [...events].reverse().find((e: any) => e.usage)?.usage);
  const start = events.find((e: any) => e.type === 'message_start')?.message?.usage ?? {};
  const delta = [...events].reverse().find((e: any) => e.type === 'message_delta')?.usage ?? {};
  return usageOf('anthropic', {...start, ...delta});
}
function settle(model: string, u: Usage) {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model}`);
  return (u.input * p.input * p.cacheWriteFactor + u.output * p.output) / 1e6;
}
function reservation(model: string, bodyBytes: number, maxOut: number) {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for ${model}`);
  // Input tokens are bounded by request bytes (+512); output (incl. reasoning) by the request's limit.
  return ((bodyBytes + 512) * p.input * p.cacheWriteFactor + maxOut * p.output) / 1e6;
}

// ---- local embeddings --------------------------------------------------------------------------------------
function hashEmbedding(text: string, dims: number) {
  const v = new Array(dims).fill(0);
  for (const tok of String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const h = createHash('sha256').update(tok).digest();
    v[h.readUInt32BE(0) % dims] += h[4] & 1 ? 1 : -1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map(x => x / norm);
}

// ---- mock answerer (dry runs only) -----------------------------------------------------------------------
// The scripted plan is {calls: [{tool, args}], declared}. The mock makes the next scripted tool call unless
// the latest tool result in the prompt asks the user to confirm (then it ends the turn with a reply). This
// follows v2's confirmation flow: each financial action is first proposed, the turn ends asking the user,
// and it is executed after the user's "yes"; the planner may then propose the next action in the same turn.
// Every other request is answered by filling its tool or output schema with neutral defaults, never from
// model inference.
const PREFS: Record<string, any> = {shouldRespond: 'RESPOND', replyEffectStatus: 'pending', decision: 'FINISH', success: true};
function fillSchema(schema: any, prefs: Record<string, any>, name = ''): any {
  if (!schema || typeof schema !== 'object') return null;
  if (name in prefs && (schema.enum ? schema.enum.includes(prefs[name]) : true)) return prefs[name];
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const alt = schema.anyOf ?? schema.oneOf;
  if (alt) return fillSchema(alt.find((s: any) => s.type !== 'null') ?? alt[0], prefs, name);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type;
  if (type === 'object' || schema.properties) {
    const out: any = {};
    for (const k of Object.keys(schema.properties ?? {})) if ((schema.required ?? []).includes(k) || k in prefs) out[k] = fillSchema(schema.properties[k], prefs, k);
    return out;
  }
  if (type === 'array') return [];
  if (type === 'string') return '';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  return null;
}
function toolsOf(provider: string, body: any): {name: string; schema: any}[] {
  return (body.tools ?? []).map((t: any) => provider === 'openai'
    ? {name: t.function?.name ?? t.name, schema: t.function?.parameters ?? t.parameters}
    : {name: t.name, schema: t.input_schema});
}
/** Text of the most recent tool result in the conversation (Chat Completions or Messages). */
function lastToolResult(provider: string, body: any): string {
  const msgs: any[] = body.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (provider === 'openai' && m.role === 'tool') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (provider === 'anthropic' && Array.isArray(m.content)) {
      const r = m.content.find((c: any) => c.type === 'tool_result');
      if (r) return typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    }
  }
  return '';
}
function mockDecision(provider: string, body: any): {kind: string; tool?: {name: string; args: any}; text?: string} {
  const plan = context?.mockPlan ?? {calls: [], declared: 'IN_PROGRESS'};
  const closing = context?.turnKind === 'closing';
  const tools = toolsOf(provider, body);
  const byName = (n: string) => tools.find(t => t.name === n);
  const next = plan.calls[mockState.step];
  const handle = byName('HANDLE_RESPONSE');
  if (handle) {
    const contextsSchema = handle.schema?.properties?.contexts?.items;
    const enumCtx: string[] = contextsSchema?.enum ?? [];
    const walletCtx = enumCtx.find(c => /wallet|finance|crypto/i.test(c)) ?? 'wallet';
    const prefs = {...PREFS, contexts: closing || !next ? ['simple'] : [walletCtx], intents: closing ? ['report status'] : ['run wallet action'],
      replyText: closing ? plan.declared : 'Working on it.', replyEffectStatus: closing ? 'none' : 'pending',
      candidateActionNames: closing || !next ? [] : [next.tool], facts: [], relationships: []};
    return {kind: 'stage1', tool: {name: 'HANDLE_RESPONSE', args: fillSchema(handle.schema, prefs)}};
  }
  const awaitingUser = mockState.callsThisTurn > 0 && /reply yes/i.test(lastToolResult(provider, body));
  if (!closing && next && !awaitingUser && mockState.callsThisTurn < 2 && byName(next.tool)) {
    mockState.step++; mockState.callsThisTurn++;
    return {kind: 'planner_call', tool: {name: next.tool, args: next.args}};
  }
  const reply = byName('REPLY');
  if (reply) return {kind: 'planner_reply', tool: {name: 'REPLY', args: fillSchema(reply.schema, {...PREFS, text: closing ? plan.declared : 'Please confirm to continue.'})}};
  if (tools.length === 1) return {kind: 'forced_tool', tool: {name: tools[0].name, args: fillSchema(tools[0].schema, PREFS)}};
  // Structured output: OpenAI response_format, Anthropic output_config.format.
  const fmt = body.response_format?.json_schema?.schema ?? body.output_config?.format?.schema;
  if (fmt) return {kind: 'structured', text: JSON.stringify(fillSchema(fmt, PREFS))};
  return {kind: 'text', text: closing ? plan.declared : 'ok'};
}
function mockBody(provider: string, model: string, d: ReturnType<typeof mockDecision>, promptChars: number, n: number) {
  const outChars = JSON.stringify(d.tool ?? d.text ?? '').length;
  const inTok = Math.ceil(promptChars / 4), outTok = Math.ceil(outChars / 4);
  if (provider === 'openai') {
    const message: any = {role: 'assistant', content: d.tool ? null : d.text};
    if (d.tool) message.tool_calls = [{id: `call_mock_${n}`, type: 'function', function: {name: d.tool.name, arguments: JSON.stringify(d.tool.args)}}];
    return {id: `chatcmpl_mock_${n}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{index: 0, message, finish_reason: d.tool ? 'tool_calls' : 'stop'}],
      usage: {prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok}};
  }
  return {id: `msg_mock_${n}`, type: 'message', role: 'assistant', model, stop_sequence: null,
    content: d.tool ? [{type: 'tool_use', id: `toolu_mock_${n}`, name: d.tool.name, input: d.tool.args}] : [{type: 'text', text: d.text}],
    stop_reason: d.tool ? 'tool_use' : 'end_turn', usage: {input_tokens: inTok, output_tokens: outTok}};
}
/** The same mock answer as an SSE stream, for requests with stream: true. */
function mockSse(provider: string, b: any): string {
  const ev = (o: any) => `data: ${JSON.stringify(o)}\n\n`;
  if (provider === 'openai') {
    const m = b.choices[0].message, base = {id: b.id, object: 'chat.completion.chunk', created: b.created, model: b.model};
    const delta = m.tool_calls ? {role: 'assistant', tool_calls: m.tool_calls.map((t: any, index: number) => ({index, ...t}))} : {role: 'assistant', content: m.content};
    return ev({...base, choices: [{index: 0, delta, finish_reason: null}]}) + ev({...base, choices: [{index: 0, delta: {}, finish_reason: b.choices[0].finish_reason}]})
      + ev({...base, choices: [], usage: b.usage}) + 'data: [DONE]\n\n';
  }
  const c = b.content[0];
  const named = (type: string, o: any) => `event: ${type}\ndata: ${JSON.stringify({type, ...o})}\n\n`;
  return named('message_start', {message: {...b, content: [], stop_reason: null, usage: {input_tokens: b.usage.input_tokens, output_tokens: 0}}})
    + named('content_block_start', {index: 0, content_block: c.type === 'tool_use' ? {type: 'tool_use', id: c.id, name: c.name, input: {}} : {type: 'text', text: ''}})
    + named('content_block_delta', {index: 0, delta: c.type === 'tool_use' ? {type: 'input_json_delta', partial_json: JSON.stringify(c.input)} : {type: 'text_delta', text: c.text}})
    + named('content_block_stop', {index: 0})
    + named('message_delta', {delta: {stop_reason: b.stop_reason, stop_sequence: null}, usage: {output_tokens: b.usage.output_tokens}})
    + named('message_stop', {});
}

Bun.serve({
  port, hostname: '127.0.0.1', idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/control/')) {
      if (url.pathname === '/control/turn' && req.method === 'POST') {
        context = await req.json();
        if (context.resetMock) mockState = {step: 0, callsThisTurn: 0};
        mockState.callsThisTurn = 0;
        return Response.json({ok: true});
      }
      if (url.pathname === '/control/idle') { context = null; return Response.json({ok: true}); }
      if (url.pathname === '/control/ledger') return Response.json({mode, calls, priorUSD, usedUSD, newUSD: usedUSD - priorUSD, cohortCap, cumulativeCap});
      return new Response('unknown control', {status: 404});
    }
    const provider = url.pathname.startsWith('/openai/') ? 'openai' : url.pathname.startsWith('/anthropic/') ? 'anthropic' : null;
    if (!provider || req.method !== 'POST') return new Response('not allowed', {status: 403});
    const body = JSON.parse(await req.text());
    const n = ++calls;
    const entry: any = {call: n, at: new Date().toISOString(), provider, path: url.pathname, model: body.model,
      episodeId: context?.episodeId ?? null, turn: context?.turn ?? null, normalized: [] as string[]};
    if (url.pathname.endsWith('/embeddings')) {
      // Local, deterministic and free; the same for every cohort. Never forwarded, so no turn is required.
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const dims = Number(body.dimensions ?? 1536);
      entry.status = 'local_embedding'; entry.inputs = inputs.length; entry.estimatedUSD = 0;
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({object: 'list', model: body.model, data: inputs.map((t: string, index: number) => ({object: 'embedding', index, embedding: hashEmbedding(t, dims)})),
        usage: {prompt_tokens: 0, total_tokens: 0}});
    }
    if (!context) {
      entry.status = 'refused_outside_turn';
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: no active episode turn.'}}, {status: 503});
    }
    if (provider === 'openai' && String(body.model).startsWith('gpt-6') && 'temperature' in body) { delete body.temperature; entry.normalized.push('temperature'); }
    if (provider === 'openai' && String(body.model).startsWith('gpt-6') && url.pathname.endsWith('/chat/completions') && Array.isArray(body.tools) && body.tools.length
        && body.reasoning_effort !== 'none') { body.reasoning_effort = 'none'; entry.normalized.push('reasoning_effort:none'); }
    const sent = JSON.stringify(body);
    // Blinding gate: refuse (never forward, never charge) any request containing a harness label or this
    // episode's identifiers, as supplied by the runner for the active turn.
    const lowered = sent.toLowerCase();
    const leaked = (context.forbidden ?? []).filter((t: string) => t && lowered.includes(String(t).toLowerCase()));
    if (leaked.length) {
      entry.status = 'refused_blinding'; entry.leakedTerms = leaked;
      writeFileSync(join(dest, 'calls', `${n}-request.json`), JSON.stringify({...entry, body}, null, 2));
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: request failed the blinding check.'}}, {status: 503});
    }
    const stream = body.stream === true;
    const maxOut = Number(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? 8192);
    entry.requestBytes = Buffer.byteLength(sent);
    entry.maxOutputTokens = maxOut;
    entry.stream = stream;
    writeFileSync(join(dest, 'calls', `${n}-request.json`), JSON.stringify({...entry, body}, null, 2));
    if (mode === 'mock') {
      const d = mockDecision(provider, body);
      const out = mockBody(provider, body.model, d, promptText(body).length, n);
      entry.mockKind = d.kind; entry.mockTool = d.tool?.name ?? null; entry.status = 'mock'; entry.estimatedUSD = 0;
      writeFileSync(join(dest, 'calls', `${n}-response.json`), JSON.stringify({httpStatus: 200, body: out}, null, 2));
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return stream ? new Response(mockSse(provider, out), {headers: {'content-type': 'text/event-stream'}}) : Response.json(out);
    }
    const reserved = reservation(body.model, entry.requestBytes, maxOut);
    if (usedUSD + reserved > cumulativeCap || usedUSD + reserved - priorUSD > cohortCap) {
      // Not forwarded, so nothing is reserved: the ledger records the would-be reservation for information only.
      entry.status = 'refused_budget'; entry.wouldReserveUSD = reserved;
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: approved budget exhausted.'}}, {status: 503});
    }
    usedUSD += reserved; entry.reservationUSD = reserved;
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (provider === 'openai') headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    else { headers['x-api-key'] = process.env.ANTHROPIC_API_KEY ?? ''; headers['anthropic-version'] = req.headers.get('anthropic-version') ?? '2023-06-01'; }
    const beta = req.headers.get('anthropic-beta'); if (beta) headers['anthropic-beta'] = beta;
    const started = performance.now();
    let status = 0, text = '', contentType = 'application/json';
    try {
      const r = await fetch(UPSTREAM[provider] + url.pathname.replace(/^\/(openai|anthropic)/, '') + url.search, {method: 'POST', headers, body: sent, signal: AbortSignal.timeout(300000)});
      status = r.status; text = await r.text(); contentType = r.headers.get('content-type') ?? contentType;
    } catch (e) {
      entry.status = 'transport_error_reservation_kept'; entry.error = (e as Error).name;
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Upstream transport failure.'}}, {status: 502});
    }
    entry.httpStatus = status; entry.latencyMs = performance.now() - started;
    const isSse = contentType.includes('text/event-stream');
    let parsed: any = null; if (!isSse) { try { parsed = JSON.parse(text); } catch {} }
    writeFileSync(join(dest, 'calls', `${n}-response.json`), JSON.stringify({httpStatus: status, sse: isSse, body: parsed ?? text}, null, 2));
    const usage = status === 200 ? (isSse ? usageOfSse(provider, text) : usageOf(provider, parsed?.usage)) : null;
    if (usage) {
      const usd = settle(body.model, usage);
      usedUSD += usd - reserved;
      Object.assign(entry, {status: 'settled', inputTokens: usage.input, outputTokens: usage.output, estimatedUSD: usd, cachedTokens: usage.cached, reasoningTokens: usage.reasoning});
    } else entry.status = status === 200 ? 'unsettled_usage_reservation_kept' : 'http_error_reservation_kept';
    appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
    return new Response(text, {status, headers: {'content-type': contentType}});
  },
});
console.log(JSON.stringify({proxy: 'llm-egress', port, mode, dest}));
