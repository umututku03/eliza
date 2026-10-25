# Fork hardening backlog

**Goal:** make our ElizaOS fork robust for multi-step on-chain tasks before any benchmark spend, by category rather than one bug per live run.

**Source:** every saved live trace so far: 13 result folders, 23 episodes, gpt-6-luna and claude-haiku-5-5, dev runs 1–4.

**Rules:**
- A fix counts only when a replay of the recorded failure passes and a tampered version is still rejected.
- Plugin suites must pass under the pinned toolchain.

## Finish line

The fork is ready for the benchmark when all four hold:
1. Every item below is fixed, or recorded as out of scope with a reason.
2. The full plugin-assistant and plugin-wallet suites pass under the pinned toolchain.
3. Mock dry runs pass on every task and condition.
4. A small live check on both models (development task only) loses no turn to a framework error: no `REPLY_GROUNDING_FAILED` and no `EVALUATOR_INVALID_OUTPUT`.

## Test environment

**Pinned toolchain: Node 24.15.0 and Bun 1.4.2.** Under any other Node, about 110 storage-backed tests fail with "Run SQLite storage with pinned Node 24.15.0 or Bun 1.4.2". Our earlier "pre-existing failures" were this and nothing else.

Under the pinned toolchain, with all fixes in place:
- plugin-assistant passes 2,736 of 2,736 tests;
- plugin-wallet passes 218 of 218 (1 skipped).

## Items

| # | Category | Evidence | Status |
|---|---|---|---|
| H1 | Reply grounding: limits, traded amounts and user approvals misread as claims | 9 rejected Haiku drafts (A9 a, b, e) | fixed `c9ada50f86` |
| H2 | Reply grounding: no EVM holdings evidence | the same drafts (A9 c) | fixed `ca3423ee4e`, `c9ada50f86` |
| H3 | Wallet results carry no effect receipt | recovery review: "receipt IDs are empty" (A9 d) | fixed `ca3423ee4e` |
| H4 | Reply grounding: true claims about an earlier turn's effect always rejected | 3 of 4 `financial_completion` drafts (A9 f) | fixed by verification: a `tx_status` read this turn proves the claim (H7) |
| H5 | The post-turn evaluator fails on every Haiku turn | `EVALUATOR_INVALID_OUTPUT` 101 times, Haiku only | fixed `8dc111fce9` (fenced JSON accepted) |
| H6 | Anthropic: the evaluator schema exceeds the plugin's optional-parameter limit, then `json_object` is silently ignored | no evaluator request carried `output_config` | open (the root of H5) |
| H7 | No on-chain way to check a transaction or refresh balances; agents call keyless external APIs instead | 89 Birdeye start failures; repeated `WALLET_SEARCH_ADDRESS` and `WALLET_TOKEN_INFO` network failures; drafts saying "could not confirm" | fixed: WALLET `tx_status` and `balance`, read on-chain; checked on the fork |
| H8 | Turn-cached context shows balances from before the turn's own trade | call 22 shows 0 USDC right after the sale (A8) | open |
| H9 | Wrong tool for a swap or a lookup (`WALLET_BRIDGE` with `action: token_info` or `swap`) | parameter errors in dev runs 2–3 | model behaviour; check whether the tool descriptions invite it |

## Checked and not a defect

- **The confirmation gate:** in dev run 4, the second sale came after an explicit "Yes, confirm." to a re-proposed sale. Haiku's statement that it "sent that swap before you had confirmed it" is false.
- **"cli-inference … session limit":** this is a fixture string in two message tests, not a real model call.
- **"TEXT_LARGE … Service Unavailable" (25 times):** these are our proxy's budget refusals in dev run 1 (fixed in the harness), not provider failures.

## 26 October 2026 hardening: H8

H8 is fixed locally. The EVM service was refreshed after submission, but the planner base context and evaluator context retained the already composed provider text. `results-dev4-haiku-stock/llm/calls/22-request.json` (turn 1) says 1 ETH / 0 USDC after transaction `0x91a67de983433b603a6261a46fdf94ba88d982faac815f6982bbe11a49d314fb`; the episode oracle records +237.636476 USDC and gas-adjusted native balance 0.899863606673511392 ETH.

A confirmed EVM wallet submission now explicitly requests `evm-wallet` refresh. The planner uses the existing named-provider compose contract to replace composed provider events in planner and evaluator context. Other cached providers are reused; proposals, failed and unconfirmed results do not claim a confirmed change. Nested planners propagate the refresh to their parent.

The replay retains public fork transaction fields and the recorded balance excerpt. It uses a real runtime composer: two wallet reads after a submission, one unrelated provider read. The tampered prose-only failure cannot refresh context. The router replay checks submission, proposal and unconfirmed cases. Reverting the respective production files to `29f3a4fb91` gives 1 failure / 1 pass (planner) and 1 failure / 26 passes (router); fixed targeted tests pass. Full suites will be repeated at the final offline gate. Initial pinned baselines: assistant 2736 passed, wallet 218 passed / 1 skipped. Restricted runs hit localhost `listen EPERM`; unrestricted runs pass.

Type checks stop before analysis: this installed workspace lacks the `node` type library in assistant and `bun` in wallet (TS2688). No type-check success is claimed.

## 26 October 2026 hardening: H6

H6 is fixed locally. In `results-dev4-haiku-stock/episodes/haiku-v2-r1-normal.child-stderr.log:11`, one refusal permanently disables schema requests. The saved evaluator call `llm/calls/6-request.json` has no output_config; its response is a fenced object. The replay rebuilds the merged schema from the six actual evaluator definitions and passes it through the real Anthropic optional-parameter check. Its typed local refusal now falls back for that call, clears the rejection streak, and never arms the lifetime provider memo. Repeated oversized schemas do not prevent a later small schema from working.

Anthropic cannot enforce schema-free json_object through the installed SDK: the SDK explicitly ignores JSON response format without a schema. The plugin now rejects that request locally with ANTHROPIC_JSON_OBJECT_UNSUPPORTED instead of silently discarding it. The evaluator explicitly selects its existing plain-JSON prompt fallback, whose output remains validated; genuine provider schema incompatibility still gets memoized. This does not make oversized schemas supported or promise constrained output in the plain fallback.

Tests: recorded fenced response replay, two consecutive actual local budget refusals, later small-schema recovery, genuine provider incompatibility memo, and a prose-wrapped tamper rejected with no processor effects (74 assistant evaluator tests pass). Local wire tests reject unsupported json_object before HTTP and still enforce responseSchema when both are requested (27 Anthropic tests pass). Unfixed evaluator: 1 replay failure; unfixed adapter: 1 expected replay failure. Node 24.15.0; no paid calls.

## 26 October 2026 hardening: analytics availability

Closed locally. Dev3 Haiku stock calls 11, 13 and 17 requested CoinGecko token_info, Birdeye search_address and DexScreener token_info. Call 12 carries the blocked CoinGecko host; the archive's episode guard permits localhost only. The provider registry advertised every provider without checking credential/service readiness or the host's network configuration.

Token-info metadata now reports readiness. Birdeye requires its credential/cloud route, DexScreener requires its service, and external HTTP analytics can be explicitly disabled with WALLET_ANALYTICS_ENABLED=false. The planner receives scoped unavailable reasons; promoted analytics validation hides unavailable calls, and forced routing refuses them before HTTP. Public DexScreener/CoinGecko access stays keyless when enabled; readiness never claims verified connectivity. Local on-chain balance and tx_status remain independently available. The episode child declares its existing network restriction through this setting; the protocol append discloses it. No task/fault/scoring change.

Four archive-based cases fail on the old implementation. Fixed replay checks all three calls, forced-call refusals with zero fetches, provider context, independent balance admission, and missing Birdeye credentials even when public analytics are enabled. Ten targeted availability/planner-argument tests pass. Biome 2.5.15 formats the modified child and reports its existing explicit-any warnings; no lint errors.

## 26 October 2026 hardening: H9

H9 has a metadata defect, so a narrow description fix is warranted. Dev2 Haiku stock call 8 requests WALLET_BRIDGE with action=swap; dev3 Haiku plan_guard call 19 requests it with action=token_info. The recorded bridge schema correctly pins enum=[bridge], but its action description still appends examples for transfer, swap, gov and token_info. The tool's only operation-specific text was “WALLET operation bridge”, followed by the whole wallet-family description.

Promotion now pins discriminator examples and compressed descriptions along with the enum. WALLET_BRIDGE has an explicit cross-chain description and points to the correct sibling tools for swaps, analytics and chain reads. The dispatcher/validation rules are unchanged. Two recorded wrong-tool calls remain rejected, a correctly shaped bridge still validates, and the wire description no longer offers sibling operations as bridge discriminator examples. Both replay cases fail before the fix; restoring only the original core promotion also fails both cases. This establishes contradictory metadata, not that descriptions caused every model error or that a live model will stop making them.

H6 follow-up: the source-aware type check exposed that responseFormat also accepts strings. The local json_object refusal now handles both the string and object forms; the wire replay covers both. The change is confined to request-shape handling.

H9 integration follow-up: the complete assistant suite caught three compact alias-contract regressions when the pinned example was repeated in the description. Promotion now drops the inherited examples entirely (the enum/default already carry the exact value), preserving the canonical pin description and alias reconstruction contract. The original contradictory examples remain absent. The existing alias-contract tests are retained unchanged.
