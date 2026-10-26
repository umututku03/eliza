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

## Offline gate status, 25 October 2026 (America/Toronto)

The original status table above is historical; this append records the completed hardening status without rewriting earlier findings.

| Item | Current status | Fix commits |
|---|---|---|
| H8 | fixed; recorded replay and tampered case pass | b9c180dea5 |
| H6 | fixed; local budget is not permanent incompatibility, unsupported JSON mode is explicit | 0f7b54b776, 3df4c89a67 |
| Analytics availability | fixed; unavailable providers hidden/marked and forced calls refused locally | 751c40201d |
| H9 | fixed contradictory description metadata; wrong calls still rejected | ae031e00b8, 2f37495104 |

Final pinned suites: assistant 2740/2740, wallet 225 passed / 1 skipped, Anthropic 28/28. Assistant and wallet type checks pass after local-only type-library links. Fork route control 11/11. All four tasks × all three conditions × both scripted models pass: 12 complete mock folders, 96 agent episodes plus 48 controls, and 108 tamper rejections. New model spend $0. No turn errors, blocked hosts, nonzero agent child exits, REPLY_GROUNDING_FAILED or EVALUATOR_INVALID_OUTPUT in those mocks.

Remaining lifecycle observation: H3/stock has 4 refused_outside_turn ledger entries (calls 73–76), from evaluation attempts after turn closure; the logs show POST_TURN_MEMORY / room-queue-closed diagnostics. The guard refuses these before provider forwarding, and the cell's audit and nine tamper checks pass. No rerun. This background-evaluation/shutdown race remains open outside the four requested fixes. Optional Birdeye service startup still logs missing-route retries separately from tool availability.

Root repository verification is blocked by the filtered install's missing root Biome dependency; Anthropic's standalone type-check is blocked by workspace/imported-source diagnostics. Explicit pinned Biome checks and all required suites above pass. Full evidence and retained wrapper-error details: `hardening-report-2026-10-25-codex.md`.

Stopped at the live-check gate. Both-model development-task live validation still needs fresh user spending approval; it has not been run. No benchmark-scale live run, push, or upstream issue/PR activity.

## 25 October 2026 live check, and fixes L1–L5

**Live check:** D1/normal, r = 1, both models, stock and plan_guard, at source `2cca02b446`. Spend $0.3682. All four audits PASS; 9/9 tamper cases rejected after `efeec47289`, which fixed a verifier crash on a deleted response.

**Outcome:**
- Both Luna episodes completed the on-chain task exactly, with no duplicate sale.
- Neither Haiku episode reached step 2.
- One `REPLY_GROUNDING_FAILED`; no `EVALUATOR_INVALID_OUTPUT`.

**The finish line is not met yet:** the second live check after these fixes is pending approval.

| # | Problem (evidence in `next-steps-2026-10-25.md` §2) | Fix | Tests |
|---|---|---|---|
| L1 | Credential redaction masked `fromToken`/`toToken`/`token`/`tokens`; models copied `"[REDACTED]"` into swaps | `0bf39964e2` (core): value-aware for asset fields; credentials under the same names stay masked | core `tool-diagnostics-chain-assets` 4 (fail on old code) |
| L2 | Earlier turns' transaction hashes not in context; agent could not check its own trades | `3972fbad47`: wallet submission history in the `evm-wallet` context | `wallet-submissions` 2, router 1; fork route `contextListsBothSubmissions` |
| L3a | Confirmation keyed on the chain's spelling ("ethereum" vs "mainnet") | `3972fbad47`: bind the resolved registry key | router 1 (fails on old code); a different chain is still re-asked |
| L3b | Confirmation split by an echoed own-address `recipient` on EVM swaps | `0e15b8cb4b`: EVM swap binding ignores `recipient` (EVM SwapParams have none) | router 2: the swap test fails on old code; the transfer recipient guard is kept |
| L4 | Holdings check read "should yield about 37 DAI" and "with 38 USDC" as holdings | `13c9389b3f` | 1 test from both live drafts (fails on old code); "left with 999 USDC" still rejected |
| L5 | Reply grounding read pre-trade providers after a confirmed write | `2fed8141f6`: merge refreshed providers into the turn state | `refreshed-providers` 2 |

**Validation after L1–L5, pinned toolchain:**
- core 382/384: the 2 failures are `logger.native-esm`, which needs a built `dist/` and `tsx`, and fails identically before the change;
- assistant 2,743/2,743;
- wallet 230/230 (1 skipped);
- fork route control 12/12;
- mock D1 stock, D1 plan_guard and H1 existing_controls: all PASS, 9/9 tamper rejected, every episode matches its oracle.

**Still open:**
- the wrong final declaration (IN_PROGRESS on a completed task) needs re-checking after L2;
- B2 (goal used as input) is model behaviour, and plan_guard's floor contains it;
- the Haiku budget cap of $0.16 per episode was hit once.

## Live check 2 stop and L6 — 26 October 2026 UTC

At source 12b6f99a02, the two Haiku D1/normal cells both execute one sale and step 2 and meet goal/reserve. Both audits PASS and reject all nine tamper cases. The plan_guard ledger has one budget refusal (call 57); the required stop prevents both Luna cells and all Task B cleanup/push. New spend 0.170291200 USD; cumulative 3.557639450 USD. Full comparison and evidence: `live-check-2-2026-10-26.md`.

L1 has no masked asset values in the two new cells; only key fields remain masked. L2 uses real earlier-turn sale hashes (stock call 32, plan_guard call 39). L3a is exercised successfully across mainnet/ethereum spellings (plan_guard calls 17 and 21); the recipient variant is not exercised. A prose-only approval request still causes an extra confirmation because no pending gate exists after dry-run/simulate. L5 is not exercised in post-trade recovery. No final REPLY_GROUNDING_FAILED or EVALUATOR_INVALID_OUTPUT occurs.

| ID | Symptom and trace | Status |
|---|---|---|
| L6 (remaining L4 mechanism) | Plan_guard call 11's quote ends “58.13 minimum”; call 13 explicitly regenerates it after financial_holding rejection, and call 14 accepts the rewrite. The comma fragment matches the standalone quantity/symbol rule and minimum is treated as an asset label. The unchanged validator reproduces the rejection. | Open; recorded only, no fix in this task. |

The earlier “L4 fixed” status is therefore incomplete for quote labels after a comma. Recovery repaired this instance within the same turn, so it is not an additional final grounding-failure event. No Task B changes or live replacements were made after the budget stop.

## Live check 2 completed under corrected rule — 26 October 2026 UTC

The earlier Haiku-only stop is retained. The corrected rule permits cohort refusals and stops on cumulative-ceiling or validation/run failures. Only the two remaining Luna cells ran at 277ddc5ebf, with framework sources unchanged from 12b6f99a02. Both audits PASS, both reject 9/9 tamper cases, and both declare COMPLETED on completed chain state. New Luna spend 0.118577250 USD; full check-2 spend 0.288868450 USD; cumulative 3.676216700 USD. No corrected stop condition was hit.

L1/L2 and both L3 normalization subcases are exercised successfully. L4/L6 remain open. Same-turn post-write recovery for L5 is not exercised. One final REPLY_GROUNDING_FAILED occurs in Luna/stock and no EVALUATOR_INVALID_OUTPUT occurs, so the live finish line is not met.

| ID | Symptom and evidence | Status |
|---|---|---|
| L7 (related to H4) | Luna/stock turn 3 follows completed trades but its direct reply has no current action results/effect receipts. Call 34 drafts completion; call 36 request says financial_completion, No action results available, providers={}; reply recovery fails and the turn records REPLY_GROUNDING_FAILED. Closing turn still declares COMPLETED correctly. | Open; no fix. This continuation evidence gap is not counted as an independent duplicate of H4. |

See the completion addendum in live-check-2-2026-10-26.md for all four rows, call evidence and the unchanged counting rules. Task B is behavior-preserving cleanup only.

## Post-cleanup validation startup gap — 26 October 2026

| ID | Symptom and evidence | Status |
|---|---|---|
| L8 (harness/toolchain, cause unproven) | The scheduled post-cleanup D1/stock mock failed before creating a manifest under Bun 1.4.2: @metamask/utils/dist/logging.mjs imported debug as an object, then threw TypeError: debug is not a function. Preserved local log: review-post-fc-dryrun-review-post-L15-D1-stock.log; the verifier sidecar records the missing manifest. The next scheduled D1/plan_guard and H1/existing_controls mocks pass at the same source. | Open; startup observation, not a demonstrated regression in a framework fix. No patch or replacement run. The failed invocation is excluded from oracle-deviation counts because no episodes exist. |

All unit counts and the route control still match baseline. The required five-mock PASS baseline is not established if any scheduled invocation cannot start. A later scheduled duplicate D1 cell is separate evidence, not a replacement for this failure. Raw logs and any partial output stay local.
