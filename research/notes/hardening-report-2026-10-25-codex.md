# ElizaOS hardening report

Work on `research/benchmark-v1`, starting at `29f3a4fb91`. Pinned Node 24.15.0 and Bun 1.4.2. No paid model calls, pushes, or upstream issue/PR activity. The raw archive remains local and unchanged at `/Users/utkueumut/Desktop/utku/apps-projects/defi/eliza-v2-run-archive`.

## Fixes and trace evidence

| Item | Root cause and recorded evidence | Local commits | Replay and negative case |
|---|---|---|---|
| H8 | The EVM service cache refreshed after a sale, but the planner base context and evaluator context retained the composed pre-trade provider result. Dev4 Haiku stock call 22 shows 1 ETH / 0 USDC after the first sale; the episode records +237.636476 USDC. | `b9c180dea5` | Real composer + planner replay refreshes wallet context, including the next model request, while an unrelated turn-cached provider is read once. Router replay uses the recorded submission. Proposal/unconfirmed results retain no confirmed-effect refresh signal; a prose-only failed action cannot trigger refresh. |
| H6 | A local optional-parameter schema-budget refusal was treated as permanent provider incompatibility. Dev4 Haiku stock stderr line 11 arms the memo after one refusal; evaluator call 6 has no output_config and returns fenced JSON. | `0f7b54b776`, `3df4c89a67` | Real merged schemas from six evaluators hit the real local budget check twice; later small-schema output still works. Genuine provider incompatibility is still memoized. Prose-wrapped output is rejected without processor effects. Local wire tests explicitly reject both schema-free json_object forms before HTTP and keep supported responseSchema enforced. |
| Analytics availability | Registry entries advertised providers without checking credentials/service readiness or the host network restriction. Dev3 Haiku stock calls 11/13/17 attempt CoinGecko, Birdeye and DexScreener; call 12 records the blocked CoinGecko host. | `751c40201d` | Three recorded calls are unavailable under the declared offline configuration; forced calls fail before fetch. Missing Birdeye credentials remain rejected when public analytics are enabled. Public DexScreener/CoinGecko remain keyless, and on-chain balance admission remains available. |
| H9 | Bridge enum was pinned but discriminator examples still advertised swap/token_info and other siblings; only a generic bridge blurb preceded the whole family description. Dev2 Haiku stock call 8 and dev3 Haiku plan_guard call 19 show the mismatched calls. | `ae031e00b8`, `2f37495104` | Both wrong-tool calls remain invalid; a correctly shaped bridge validates. Wire descriptions drop contradictory examples and explain cross-chain scope. The existing alias-contract tests remain unchanged. |

The Anthropic fix makes the unsupported json_object request explicit; it does not add schema-free constrained output support. Oversized schemas use the existing plain-JSON prompt fallback and output validation. The analytics host setting declares the already enforced network restriction; it does not probe connectivity or change the task, faults, approval flow or scoring. Descriptions alone do not establish that live models will select the right tool.

## Red/green evidence

| Replay | Unfixed production code | Fixed code |
|---|---|---|
| H8 planner | 1 failed / 1 passed at the original planner file | 2 passed |
| H8 router | 1 failed / 26 passed at the original router file | 27 passed |
| H6 evaluator | Recorded replay fails: the second schema attempt is skipped | Recorded replay and genuine incompatibility case pass; malformed output is rejected |
| H6 adapter | Unsupported-json_object replay fails against original adapter | 28 adapter tests pass |
| Availability | All 4 original cases fail on old registry/validation behavior | 4 replay cases and 6 existing planner-argument tests pass |
| H9 | Both cases fail against original descriptions; reverting only core promotion also fails both | 2 passed; 14 unchanged alias-contract tests pass |

Fixtures retain public trace excerpts and source SHA-256 values; complete raw requests/responses are not copied into git. The archive checksum manifest lists itself: its self-entry differs, while the other 9,943 listed files match.

## Final offline validation

- Initial pinned baseline: assistant 2,736/2,736; wallet 218 passed / 1 skipped.
- Final assistant: **2,740/2,740**, 204 files.
- Final wallet: **225 passed / 1 skipped**, 37 files.
- Final Anthropic adapter: **28/28**.
- Assistant and wallet type checks: pass after linking the already installed Node/Bun type libraries in ignored node_modules. No global toolchain change.
- Pinned-fork control-v2-route: **11/11**; step 1 237.636476 USDC, step 2 178.23 USDC and 59.046981018462803274 DAI.
- Biome 2.5.15: all changed source/fixture files checked; the formatted harness child retains existing explicit-any warnings. Markdown is outside the configured Biome language set.

All 12 cells passed. Each has 4 control episodes and 8 agent episodes (2 models × 4 scenarios, one repetition), with all 9 tampered copies rejected. Results remain local and ignored. Audit sidecars use `.verified.audit.json`; tamper logs use `.tamper.log`. All folder names below are under `research/agent-harness-v2/`.

| Task | Condition | Results folder | Audit | Tamper rejections | Model calls | Outside-turn refusals | Model spend |
|---|---|---|---|---:|---:|---:|---:|
| D1 | stock | `dryrun-hardening-20261026-2f374951b-D1-stock` | PASS | 9/9 | 174 | 0 | $0 |
| D1 | plan_guard | `dryrun-hardening-20261026-2f374951b-D1-plan_guard` | PASS | 9/9 | 174 | 0 | $0 |
| D1 | existing_controls | `dryrun-hardening-20261026-2f374951b-D1-existing_controls` | PASS | 9/9 | 174 | 0 | $0 |
| H1 | stock | `dryrun-hardening-20261026-2f374951b-H1-stock` | PASS | 9/9 | 174 | 0 | $0 |
| H1 | plan_guard | `dryrun-hardening-20261026-2f374951b-H1-plan_guard` | PASS | 9/9 | 174 | 0 | $0 |
| H1 | existing_controls | `dryrun-hardening-20261026-2f374951b-H1-existing_controls` | PASS | 9/9 | 174 | 0 | $0 |
| H2 | stock | `dryrun-hardening-20261026-2f374951b-H2-stock` | PASS | 9/9 | 174 | 0 | $0 |
| H2 | plan_guard | `dryrun-hardening-20261026-2f374951b-H2-plan_guard` | PASS | 9/9 | 174 | 0 | $0 |
| H2 | existing_controls | `dryrun-hardening-20261026-2f374951b-H2-existing_controls` | PASS | 9/9 | 174 | 0 | $0 |
| H3 | stock | `dryrun-hardening-20261026-2f374951b-H3-stock` | PASS | 9/9 | 175 | 4 | $0 |
| H3 | plan_guard | `dryrun-hardening-20261026-2f374951b-H3-plan_guard` | PASS | 9/9 | 174 | 0 | $0 |
| H3 | existing_controls | `dryrun-hardening-20261026-2f374951b-H3-existing_controls` | PASS | 9/9 | 174 | 0 | $0 |

Totals: 12 cells, 48 controls, 96 agent episodes, 2089 scripted model calls, 108 rejected tamper cases, **$0 new model spend**. All 96 agent children exited 0. No blocked hosts, turn errors, EVALUATOR_INVALID_OUTPUT or REPLY_GROUNDING_FAILED were recorded. There were **4 outside-turn refusals**, described below. These are scripted-model checks, not live reliability observations.


## Check limitations and retained attempts

Restricted baseline suites encountered localhost listen EPERM; unrestricted offline suites passed. The first full assistant run caught three alias-contract regressions from the new discriminator example; the follow-up removes examples entirely and the final full suite passes.

Root `bun run verify` stops because the filtered workspace install lacks the root @biomejs/biome dependency used by build-control-channel.mjs. This is separate from the successful explicit pinned Biome checks. The normal Anthropic type-check config cannot resolve unbuilt workspace declarations. With eliza-source resolution it reports strict errors in imported core/host files, with no remaining diagnostics in the changed Anthropic adapter. No full repository verification success is claimed.

An initial mock wrapper failed on system Bash 3 empty-array expansion before the runner started; its empty console log is retained. D1/stock completed once; its first verifier invocation used an incorrect relative path, then the same completed folder passed the absolute-path audit and all nine tamper tests. No model experiment was repeated for these wrapper errors.

## Live-check gate

The offline mock matrix above passes. The live finish-line requirement remains untested. The required next gate is the development-task live check on both models, with new user spending approval. No paid run or held-out live benchmark is authorized by this work.

## Remaining lifecycle observation

H3/stock ledger calls 73–76 are refused_outside_turn (episodeId and turn both null). The adjacent in-turn call 72 belongs to luna-v2-H3-r1-price_change_feasible, turn 4. That episode's child stderr labels the four attempts purpose=evaluation and shows three OpenAI retries after the guard returns HTTP 503 (“no active episode turn”), followed by POST_TURN_MEMORY / room-queue-closed diagnostics. The proxy refused all four before any provider forwarding. The episode and full cell still complete with exit 0 and passing audit/tamper checks. This is a remaining background-evaluation/turn-shutdown lifecycle issue, outside the four requested fixes; it is not evidence of a paid call or a turn-level evaluator-output failure. No rerun was made. Birdeye's optional service startup still emits missing-route retry diagnostics even when its analytics tools are unavailable; capability truthfulness does not claim to remove that separate startup noise.

Validation evidence is retained in ignored `test-results/hardening-20261026/` (red/green logs, final suite/type-check logs, local Anthropic source config, final-summary.json). Source head for the complete mock matrix: `2f37495104`. The source tree was unchanged throughout all twelve cells.
