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
// upstream 'compat': an OpenAI-compatible host for open-weight models (e.g. Anyscale), reached at
// COMPAT_BASE_URL with COMPAT_API_KEY; both come from the keys file and are never logged. The agent still talks
// to /openai/v1 through this proxy, so blinding, caps and the ledger apply unchanged. Prices for compat models are
// the host's per-token rates (credits or not), so the caps keep meaning.
export const PRICES: Record<string, {input: number; output: number; cacheWriteFactor: number; upstream?: 'compat'}> = {
  'gpt-6-luna': {input: 0.10, output: 0.50, cacheWriteFactor: 1.25},
  'gpt-6.1-sol': {input: 2, output: 10, cacheWriteFactor: 1.25},
  'claude-haiku-5-5': {input: 0.10, output: 0.50, cacheWriteFactor: 1},
  'claude-opus-5-5': {input: 4, output: 20, cacheWriteFactor: 1},
  'gpt-4.1-mini': {input: 0.40, output: 1.60, cacheWriteFactor: 1},
  'claude-sonnet-5-5': {input: 2, output: 10, cacheWriteFactor: 1},
  // Open-weight models on the compat host are added here once the host's model list and rates are confirmed.
};
const isCompat = (model: string) => PRICES[model]?.upstream === 'compat';
const UPSTREAM: Record<string, string> = {openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com'};
if (testUpstream) { UPSTREAM.openai = testUpstream; UPSTREAM.anthropic = testUpstream; }

let context: any = null;            // {episodeId, turn, turnKind, mockPlan?, forbidden} while a turn is active
const freshMockState = (episodeId: unknown = null) => ({episodeId, step: 0, callsThisTurn: 0,
  observations: new Map<string, any>(), sequence: 0});
let mockState = freshMockState();
let calls = 0, usedUSD = priorUSD, budgetRefusals = 0, inFlight = 0;
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
// visible-financial-results-v1: mock verdicts trust only structured tool claims the agent saw.
// The required action identities come from the public task, never a scenario/oracle label. This is
// conservative mock QA, not independent chain-finality or balance/goal verification (the auditor does that).
const FINANCIAL_TOOLS = new Set(['swap', 'transfer', 'bridge', 'gov', 'pump_fun_buy', 'approve_token', 'aave_supply']);
const mockToolName = (name: string) => String(name).split('__').at(-1)!.toLowerCase().replace(/^wallet_/, '');
function mockIdentity(value: any): any {
  if (Array.isArray(value)) return value.map(mockIdentity);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, mockIdentity(value[k])]));
  if (typeof value !== 'string') return value;
  if (/^0x[0-9a-f]+$/i.test(value)) return value.toLowerCase();
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const negative = value.startsWith('-'), [whole, frac = ''] = value.replace(/^-/, '').split('.');
    const n = whole.replace(/^0+(?=\d)/, ''), f = frac.replace(/0+$/, '');
    return `${negative && (n !== '0' || f) ? '-' : ''}${n}${f ? `.${f}` : ''}`;
  }
  return value;
}
function mockResult(value: any): any {
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } continue; }
    if (Array.isArray(value)) { value = value.filter(x => x?.type === 'text').map(x => x.text).join(''); continue; }
    if (value && typeof value === 'object' && Array.isArray(value.content)) { value = value.content; continue; }
    return value && typeof value === 'object' ? value : null;
  }
  return null;
}
const mockHash = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
function rememberMockResults(provider: string, body: any) {
  const issued = (id: unknown, name: string, args: any) => {
    const tool = mockToolName(name);
    if (typeof id !== 'string' || (!FINANCIAL_TOOLS.has(tool) && tool !== 'tx_status')) return;
    try { if (typeof args === 'string') args = JSON.parse(args); } catch { args = null; }
    const identity = mockIdentity(args), key = JSON.stringify([tool, identity]);
    const old = mockState.observations.get(id);
    if (!old) mockState.observations.set(id, {tool, args: identity, key, state: 'unknown', hashes: [], nonce: null, sequence: 0});
    else if (old.key !== key) { old.state = 'unknown'; old.contradicted = true; }
  };
  const observed = (id: unknown, raw: any, isError = false) => {
    const r = mockState.observations.get(String(id));
    if (!r) return; // Unmatched prose or an unrecognized tool cannot establish an execution.
    const fingerprint = JSON.stringify([raw, isError]);
    if (r.fingerprint === fingerprint) return; // Prompt history is repeated across planner/helper calls.
    if (r.fingerprint) r.contradicted = true; // A tool receipt cannot silently change under the same call id.
    r.fingerprint = fingerprint; r.sequence = ++mockState.sequence;
    const v = mockResult(raw), data = v?.data ?? v, ev = data?.evidence;
    r.hashes = [...new Set([v?.hash, v?.transactionHash, data?.hash, data?.transactionHash,
      ...(ev?.hashes ?? []), ...(v?.effectReceipts ?? []).map((x: any) => x?.resource?.id)].filter(mockHash).map((h: string) => h.toLowerCase()))];
    const nonce = ev?.pinnedNonce ?? data?.pinnedNonce ?? v?.pinnedNonce;
    r.nonce = Number.isSafeInteger(nonce) && nonce >= 0 ? nonce : null;
    const last = ev?.observations?.at(-1);
    const orphan = ev?.state === 'orphaned' || ev?.decision === 'orphaned' || (last?.orphanEvidence === true && last?.canonical !== true);
    const failedStatus = ['pending', 'not_found', 'reverted', 'failed', 'orphaned'].includes(String(data?.status));
    if (orphan || (r.tool === 'tx_status' && failedStatus)) {
      for (const prior of mockState.observations.values()) {
        if (prior.state !== 'applied' || (r.hashes.length && !prior.hashes.some((h: string) => r.hashes.includes(h)))) continue;
        prior.state = 'pending'; prior.sequence = mockState.sequence;
        if (orphan && r.nonce !== null) prior.nonce = r.nonce;
      }
    }
    const proposal = v?.requiresConfirmation === true || data?.requiresConfirmation === true || data?.status === 'awaiting_confirmation';
    const failed = isError || v?.success === false || !!v?.error || !!data?.error;
    const receiptApplied = v?.success === true && (v?.effectReceipts ?? []).some((x: any) => x?.outcome === 'applied' && /^wallet\./.test(x?.operation ?? ''));
    const mined = data?.status === 'success' && mockHash(data?.hash) && Number.isSafeInteger(data?.block) && data.block >= 0;
    const reverted = data?.status === 'reverted' && mockHash(data?.hash) && Number.isSafeInteger(data?.block);
    r.state = r.contradicted ? 'unknown' : reverted ? 'no_effect' : failed ? 'pending' : proposal ? 'proposal'
      : r.tool === 'tx_status' ? 'read' : (receiptApplied && r.hashes.length > 0) || mined ? 'applied' : 'pending';
  };
  for (const m of body.messages ?? []) {
    if (provider === 'openai') {
      for (const t of m.tool_calls ?? []) issued(t.id, t.function?.name ?? t.name, t.function?.arguments ?? t.arguments);
      if (m.role === 'tool') observed(m.tool_call_id, m.content);
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === 'tool_use') issued(c.id, c.name, c.input);
        if (c.type === 'tool_result') observed(c.tool_use_id, c.content, c.is_error === true);
      }
    }
  }
}
function mockVerdict(): 'COMPLETED' | 'IN_PROGRESS' {
  const required = context?.mockPlan?.requiredFinancialActions;
  if (!Array.isArray(required) || !required.length) return 'IN_PROGRESS';
  const attempts = [...mockState.observations.values()].filter(r => FINANCIAL_TOOLS.has(r.tool));
  const applied = attempts.filter(r => r.state === 'applied');
  // Distinct applied hashes for one operation are a possible duplicate, not another completion proof.
  if (applied.some((a, i) => applied.slice(i + 1).some(b => a.key === b.key &&
    !a.hashes.some((h: string) => b.hashes.includes(h))))) return 'IN_PROGRESS';
  for (const r of attempts) {
    if (r.state === 'applied' || r.state === 'proposal' || r.state === 'no_effect') continue;
    const reconciled = applied.some(a => a.key === r.key && a.sequence > r.sequence &&
      (a.hashes.some((h: string) => r.hashes.includes(h)) || (a.nonce !== null && a.nonce === r.nonce)));
    if (!reconciled) return 'IN_PROGRESS';
  }
  const subset = (wanted: any, actual: any): boolean => wanted && typeof wanted === 'object'
    ? actual && typeof actual === 'object' && Object.keys(wanted).every(k => subset(wanted[k], actual[k]))
    : wanted === actual;
  return required.every(r => FINANCIAL_TOOLS.has(mockToolName(r?.tool)) && r?.args && typeof r.args === 'object' && !Array.isArray(r.args) &&
    applied.some(a => a.tool === mockToolName(r.tool) && subset(mockIdentity(r.args), a.args))) ? 'COMPLETED' : 'IN_PROGRESS';
}
function mockDecision(provider: string, body: any): {kind: string; tool?: {name: string; args: any}; text?: string} {
  const plan = context?.mockPlan ?? {calls: []};
  rememberMockResults(provider, body);
  const verdict = mockVerdict();
  const closing = context?.turnKind === 'closing';
  const tools = toolsOf(provider, body);
  const byName = (n: string) => tools.find(t => t.name === n);
  const next = plan.calls?.[mockState.step];
  const handle = byName('HANDLE_RESPONSE');
  if (handle) {
    const contextsSchema = handle.schema?.properties?.contexts?.items;
    const enumCtx: string[] = contextsSchema?.enum ?? [];
    const walletCtx = enumCtx.find(c => /wallet|finance|crypto/i.test(c)) ?? 'wallet';
    const prefs = {...PREFS, contexts: closing || !next ? ['simple'] : [walletCtx], intents: closing ? ['report status'] : ['run wallet action'],
      replyText: closing ? verdict : 'Working on it.', replyEffectStatus: closing ? 'none' : 'pending',
      candidateActionNames: closing || !next ? [] : [next.tool], facts: [], relationships: []};
    return {kind: 'stage1', tool: {name: 'HANDLE_RESPONSE', args: fillSchema(handle.schema, prefs)}};
  }
  const awaitingUser = mockState.callsThisTurn > 0 && /reply yes/i.test(lastToolResult(provider, body));
  if (!closing && next && !awaitingUser && mockState.callsThisTurn < 2 && byName(next.tool)) {
    mockState.step++; mockState.callsThisTurn++;
    return {kind: 'planner_call', tool: {name: next.tool, args: next.args}};
  }
  const reply = byName('REPLY');
  if (reply) return {kind: 'planner_reply', tool: {name: 'REPLY', args: fillSchema(reply.schema, {...PREFS, text: closing ? verdict : 'Please confirm to continue.'})}};
  if (tools.length === 1) return {kind: 'forced_tool', tool: {name: tools[0].name, args: fillSchema(tools[0].schema, PREFS)}};
  // Structured output: OpenAI response_format, Anthropic output_config.format.
  const fmt = body.response_format?.json_schema?.schema ?? body.output_config?.format?.schema;
  if (fmt) return {kind: 'structured', text: JSON.stringify(fillSchema(fmt, PREFS))};
  return {kind: 'text', text: closing ? verdict : 'ok'};
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
        if (context.resetMock || context.episodeId !== mockState.episodeId) mockState = freshMockState(context.episodeId);
        mockState.callsThisTurn = 0;
        return Response.json({ok: true});
      }
      if (url.pathname === '/control/idle') { context = null; return Response.json({ok: true}); }
      if (url.pathname === '/control/ledger') return Response.json({mode, calls, priorUSD, usedUSD, newUSD: usedUSD - priorUSD, cohortCap, cumulativeCap, budgetRefusals, inFlight});
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
      entry.status = 'refused_budget'; entry.wouldReserveUSD = reserved; budgetRefusals++;
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: approved budget exhausted.'}}, {status: 503});
    }
    usedUSD += reserved; entry.reservationUSD = reserved;
    const headers: Record<string, string> = {'content-type': 'application/json'};
    const compat = provider === 'openai' && isCompat(String(body.model));
    if (compat && !(process.env.COMPAT_BASE_URL && process.env.COMPAT_API_KEY)) {
      usedUSD -= reserved; entry.status = 'refused_config'; appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      return Response.json({error: {message: 'Refused by harness: compat host not configured.'}}, {status: 503});
    }
    if (compat) { headers.authorization = `Bearer ${process.env.COMPAT_API_KEY}`; entry.upstream = 'compat'; }
    else if (provider === 'openai') headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    else { headers['x-api-key'] = process.env.ANTHROPIC_API_KEY ?? ''; headers['anthropic-version'] = req.headers.get('anthropic-version') ?? '2023-06-01'; }
    const beta = req.headers.get('anthropic-beta'); if (beta) headers['anthropic-beta'] = beta;
    const started = performance.now();
    let status = 0, text = '', contentType = 'application/json';
    inFlight++;   // forwarded and not yet recorded; the runner waits for zero before shutting the proxy down
    try {
      const base = compat ? (testUpstream ?? process.env.COMPAT_BASE_URL!.replace(/\/v1\/?$/, '')) : UPSTREAM[provider];
      const r = await fetch(base + url.pathname.replace(/^\/(openai|anthropic)/, '') + url.search, {method: 'POST', headers, body: sent, signal: AbortSignal.timeout(300000)});
      status = r.status; text = await r.text(); contentType = r.headers.get('content-type') ?? contentType;
    } catch (e) {
      entry.status = 'transport_error_reservation_kept'; entry.error = (e as Error).name;
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
      inFlight--;
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
    inFlight--;
    return new Response(text, {status, headers: {'content-type': contentType}});
  },
});
console.log(JSON.stringify({proxy: 'llm-egress', port, mode, dest}));
