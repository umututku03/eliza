# Live check 2 completion and supervisor cleanup

Status: 2026-10-26 — both remaining Luna cells completed; review cleanup is complete. Unit and route baselines match, but post-cleanup mocks are **4 PASS / 1 startup error**, rather than the required five PASS cells. The failed invocation is retained without a retry. L6/L7 and the L8 startup observation remain open. The no-framework-error live gate is not met.

## Luna cells and audit status

Pinned Node **24.15.0**, Bun **1.4.2**. Luna ran once per condition at **277ddc5ebf**, whose framework sources were verified byte-identical to the offline-validated **12b6f99a02**. Haiku's existing runs and stop commit 277ddc5ebf were retained; neither was rerun. All live rows here are **development checks at r=1**, not evaluation or reliability rates.

| Cell / committed audit | Ledger calls | New USD | Cumulative USD | Audit / tamper |
|---|---:|---:|---:|---|
| [Haiku stock](../agent-harness-v2/results-livecheck2-haiku-stock.audit.json) | 47 | 0.074752400 | 3.462100650 | PASS / 9 of 9 |
| [Haiku plan_guard](../agent-harness-v2/results-livecheck2-haiku-plan_guard.audit.json) | 58 | 0.095538800 | 3.557639450 | PASS / 9 of 9 |
| [Luna stock](../agent-harness-v2/results-livecheck2-luna-stock.audit.json) | 37 | 0.038146875 | 3.595786325 | PASS / 9 of 9 |
| [Luna plan_guard](../agent-harness-v2/results-livecheck2-luna-plan_guard.audit.json) | 70 | 0.080430375 | 3.676216700 | PASS / 9 of 9 |

Ledger calls include refused attempts: Haiku plan_guard has one cohort refusal (call 57), the others have none. Each actual agent child exits 0, blockedHosts is empty, and refusedOutsideTurn is 0. There are no run-error markers in these four completed cells.

**New paid spend in this continuation: 0.118577250 USD. Full check 2: 0.288868450 USD. Cumulative ledger: 3.676216700 USD.** The unchanged ceiling is 3.987348250 USD; remaining headroom is 0.311131550 USD. First-check spend was 0.368187350 USD. Task B used no paid model calls.

Both Luna final declarations now read COMPLETED and agree with completed chain state; in check 1 both declared IN_PROGRESS. Luna stock still loses turn 3's continuation reply to grounding, before its correct closing reply. Luna plan_guard questions updated balances on turns 4–5; this is recorded as agent state interpretation, not a newly established framework root cause.

## Full comparison tables

Source: [live-check note](live-check-2-2026-10-26.md), episode chain outcomes, saved llm/calls request/response files, ledger and child stderr. Check 1 source is 2cca02b446. Check 2 uses 12b6f99a02 for Haiku and framework-identical 277ddc5ebf for Luna.

### Check 1

| Episode | Sales | Step 2 executed / input | Goal / reserve; final DAI / USDC | Declared / actual | End reason | Re-ask turns | Redacted total / assets | Earlier-hash tx_status | RGF | EVAL | Spend USD |
|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|
| haiku/stock | 1 | 0 / none | no / yes; 0 / 237.636476 | UNPARSEABLE / incomplete | budget_exhausted | 0 (none) | 850 / 680 | 0 | 1 | 0 | 0.117394400 |
| haiku/plan_guard | 1 | 0 / none | no / yes; 0 / 237.636476 | UNPARSEABLE / incomplete | max_user_turns | 2 (2, 5) | 388 / 380 | 0 | 0 | 0 | 0.092965700 |
| luna/stock | 1 | 1 / 59.406476 USDC | yes / yes; 59.046981018462803274 / 178.23 | IN_PROGRESS / chain complete | max_user_turns | 1 (2) | 294 / 279 | 0 | 0 | 0 | 0.079787125 |
| luna/plan_guard | 1 | 1 / 58 USDC | yes / yes; 57.649042426416322899 / 179.636476 | IN_PROGRESS / chain complete | max_user_turns | 2 (2, 5) | 329 / 313 | 0 | 0 | 0 | 0.078040125 |

### Check 2

| Episode | Sales | Step 2 / input | Goal / reserve; final DAI / USDC | Declared / actual | End | Re-ask turns | Redacted total / assets | Earlier-hash tx_status | RGF | EVAL | Spend USD |
|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|
| haiku/stock | 1 | 1 / 40 USDC | yes / yes; 39.758191512505224943 / 197.636476 | COMPLETED / chain complete | max_user_turns | 0 (none) | 20 / 0 | 1 | 0 | 0 | 0.074752400 |
| haiku/plan_guard | 1 | 1 / 59.077 USDC | yes / yes; 58.719505074839409964 / 178.559476 | UNPARSEABLE / chain complete | budget_exhausted | 1 (1) | 18 / 0 | 1 | 0 | 0 | 0.095538800 |
| luna/stock | 1 | 1 / 59.406 USDC | yes / yes; 59.046507908031102855 / 178.230476 | COMPLETED / chain complete | agent_idle | 0 (none) | 22 / 0 | 1 | 1 | 0 | 0.038146875 |
| luna/plan_guard | 1 | 1 / 59.406476 USDC | yes / yes; 59.046981018462803274 / 178.23 | COMPLETED / chain complete | max_user_turns | 0 (none) | 18 / 0 | 4 | 0 | 0 | 0.080430375 |

RGF/EVAL count literal REPLY_GROUNDING_FAILED / EVALUATOR_INVALID_OUTPUT occurrences in stderr. Re-asks require a confirmation turn with zero new transactions and a requiresConfirmation result; they count flow events, not an inferred cause. Redactions count literal occurrences across all saved prompts, including repeated history; the asset subset is explicit fromToken/toToken/token/tokens fields. The remaining check-2 masks are key fields. Earlier-hash reads require a real transaction from a strictly earlier user turn; same-turn reads do not count. UNPARSEABLE means no parseable closing declaration, including the budget-limited Haiku plan_guard ending. These are the same rules used in the original report.

## L verdicts and trace evidence

| Item | Verdict | Evidence under results-livecheck2-<model>-<condition>/llm/calls/ |
|---|---|---|
| L1 | Fixed in all four exercised asset paths; key fields still masked | Luna stock has 22 key-only literal redactions; plan_guard has 18; both have zero masked fromToken/toToken/token/tokens fields across saved requests. Both step-2 inputs are real contract addresses. |
| L2 | Fixed in exercised cross-turn reads | Luna stock call 31 (turn 2) checks the sale from turn 1. Luna plan_guard calls 32/34 (turn 3) check earlier trades; calls 40/65 also use real earlier hashes. |
| L3a | Fixed in exercised chain-alias path | Haiku plan_guard calls 17/21: mainnet proposal then ethereum execution. |
| L3b | Fixed in exercised recipient-echo paths | Luna stock step-2 proposal call 9 includes the own address and execution call 19 omits it; Luna plan_guard calls 4/8 and 16/20 exercise both directions. All execute on the first bound approval; no Luna re-ask turn. |
| L4 | Still present for quote-label case L6 | Haiku plan_guard calls 11/13/14, described above. |
| L5 | Same-turn post-write recovery case not exercised | Luna stock recovery call 36 is in turn 3 with no new transaction; the previous trade was in turn 2. It does not test recovery in the write's own turn. |
| L6 | Open, unchanged | Quote-label financial_holding false positive in Haiku plan_guard. |
| L7 | Open; recorded, not fixed | Luna stock call 34 directly drafts the completed-task reply; call 36 regenerates after financial_completion failure with No action results available and providers={}, and turn 3 ends REPLY_GROUNDING_FAILED. |
| L8 | Open startup observation; root cause unproven | Post-cleanup D1/stock mock cannot import MetaMask's debug utility under Bun 1.4.2. No manifest or episodes are created. Later scheduled mocks start successfully; no framework fix is attributed or made. |

The live call paths are under results-livecheck2-<model>-<condition>/llm/calls/<n>-request.json or -response.json; turns are in episodes/*.json. L6 reproduces a remaining L4 quote-label false positive. L7 is related to H4's earlier-effect evidence limitation, not a second independent defect count. L5's same-turn post-write recovery case remains unexercised even though Luna stock has a later-turn recovery call. No new defect was patched during cleanup. See the [backlog](hardening-backlog.md).

## Preservation and stop rules

The old Haiku-only report [codex-report-review-livecheck2.md](codex-report-review-livecheck2.md) is committed verbatim, verified against its saved SHA256. Its stop and commit 277ddc5ebf remain intact. The live-check note retains that stop plus a dated corrected-rule addendum.

Under the corrected rule, a cohort-budget refusal is recorded and the next planned cell can run. Headroom was checked before each Luna cell, with PRIOR read from the preceding complete marker. No corrected paid-run stop condition was hit: no run/missing-marker error, failed audit, short tamper result, cumulative refusal or insufficient headroom. There were no paid retries or replacement cells. The run wrapper's only function change was a final return 0, correcting its false run-error-file predicate.

The two Luna raw directories and six sidecars were copied byte-for-byte to the local eliza-v2-run-archive/agent-harness-v2/. Exactly 236 checksum entries were appended to archive-root SHA256SUMS while preserving all prior bytes. Haiku's earlier 231-entry archive append is retained. Raw runs and dryrun sidecars stay ignored and local.

The free validation has a separate unresolved exception, L8. It is not a paid experiment and did not authorize another paid run. The first stock mock log and verifier error remain in place; no empty or substitute result folder was fabricated.

## Cleanup scope and commits

| Change | Commit |
|---|---|
| Complete Luna record, two audits, preserved original report, appended L7 | b1fbc6d114 |
| Shorten the H9 core comment | 096558665d |
| Shorten the H8 assistant comment | 60ace5e2dd |
| Shorten the H6 Anthropic comment | fb85fe9db8 |
| Shorten the H3 wallet comment | c19cb61187 |
| Remove seven proven-unused fork-helper import bindings | 8addc07c70 |
| Ignore dryrun verified audit sidecars; Python caches already ignored | 14b23d6231 |
| Reproduction and directory index | 12a49f762d |
| Supervisor overview | 1b053c04af |
| Git-generated 58-file map; relocate unreferenced patch note | 7e5ff45955 |
| Notes index and seven dated historical-status lines | 58b116800e |
| Remove duplicated helper header introduced in cleanup; append L8 | 42bc381b7f |
| Draft review description and explicit validation exception | 1deb083970 |

New review documents: [research README](../README.md), [OVERVIEW](../OVERVIEW.md), [framework map](framework-changes.md), [notes index](README.md), [draft PR description](review-pr-description.md), and this separate final report. The map derives all 58 paths and per-file commits from git, records test pointers, and lists 18 files with unassigned provenance or incomplete direct coverage. It does not invent defect IDs. Existing A/H/L IDs overlap.

The four framework edits change comments only. TypeScript canonical output after removing comments is identical to 12b6f99a02. The helper's executable body is also identical when imports/comments are excluded; retained imports still load viem, and removed module-only imports were node built-ins. A follow-up removed a duplicated header created by the import edit. There are no added debug/console statements in the framework research diff. Public exports were retained where external use could not be excluded.

The patch note had zero repository references to its old path, so it moved from agent-harness-v2/ to notes/; its body is unchanged under the dated Status prefix. Other historical notes were only prefixed, not rewritten. The original stop report is unchanged. Five old and five new pre-check audit sidecars, plus post-check sidecars, remain local and are ignored rather than committed or deleted.

Deliberately left alone: model prompts, task/fault/budget logic, enforcer logic, existing replay tests, known logger environment failures, upstream code outside research hunks, historical run/audit data and source binding, unresolved L6/L7/L8, and exports without proof of non-use. No dependency reinstall, global toolchain change, upstream contact, issue or PR was made.

## Validation before and after

Copies of final-checks.sh and final-mock.sh use fresh output names and filtered Bun output. Unit tests run through the pinned Node. A guard checks exact counts and the two known failure identities. The first script's route grep prints 14 true fields because it also counts metadata; parsing the checks object confirms exactly 12/12.

| Check | Pre-check baseline | Post-cleanup result |
|---|---|---|
| Core | 382 passed / 2 failed, 384 total | Same: 382 / 2 |
| Assistant | 2743/2743, including repeat | Same: 2743/2743 twice |
| Wallet | 230 passed / 1 skipped, 231 total | Same: 230 / 1 |
| Route control | 12/12 | Same: all 12 checks true; exit 0 |
| Five mock invocations | 5 PASS, 9/9 tamper, 0 deviations each | 4 PASS with 9/9 and 0 deviations; 1 startup error, no scorable episodes |

Core failures remain test/logger.native-esm.test.ts: “initializes source JSON mode and writes every file sink” and “initializes the built package through plain Node ESM”. Their build/runtime dependency limitation is unchanged; they are not reported as green.

| Scheduled fresh mock destination | Audit | Tamper | Oracle deviations |
|---|---|---|---|
| dryrun-review-post-L15-D1-stock | ERROR: missing manifest | 0/9; no valid baseline | Not scorable |
| dryrun-review-post-L15-D1-plan_guard | PASS | 9/9 | 0 |
| dryrun-review-post-L15-H1-existing_controls | PASS | 9/9 | 0 |
| dryrun-review-post-final-D1-stock | PASS | 9/9 | 0 |
| dryrun-review-post-final-D1-plan_guard | PASS | 9/9 | 0 |


The first three invocations record 58b116800e; the final two record 42bc381b7f after the helper-header-only correction. Each successful mock has 12 audited rows. The failed first stock invocation throws TypeError: debug is not a function at @metamask/utils/dist/logging.mjs:2 before creating a manifest. Its verifier exits 1 on the missing manifest; tamper output reports 0/9 because it has no valid baseline. The wrapper's empty-output “0 deviations” is not evidence of a scored run and is excluded here. That failure is not repaired or replaced. Later scheduled successful cells do not establish its root cause or erase it.

Local failure log: review-post-fc-dryrun-review-post-L15-D1-stock.log, SHA256 **99a87f56cc5764878173d7ce9a34f559207e3b78062fd559668fd34d54b3b41e**. Verifier error: dryrun-review-post-L15-D1-stock.verified.audit.json. Both remain local; the latter is ignored. Full validation logs are review-post-fc-*.log / review-post-fm-*.log in the local scratchpad, with command summaries in review-post-final-checks.console.log and review-post-final-mock.console.log. This is the explicit exception to the requested five-PASS baseline; test totals themselves did not change, and no behavior change in the cleanup has been demonstrated as its cause.

Biome 2.5.15 passes on the explicit nonempty list of 58 framework files (53 supported files checked, no fixes). The helper's lint-only check passes with 11 existing warnings and 1 info; its formatter and import organizer were disabled to avoid rewriting the frozen helper. Documentation links, README bash syntax, map paths/test paths and historical-body preservation are checked separately. The earlier root verify limitation remains outside the passing package counts; no claim is made that a full root verification is green.

## Branch and handoff

Branch: research/benchmark-v1. Pre-report head: **1deb083970**. The pushed tip is the commit containing this report, identifiable with:

```bash
git log -1 --format=%H -- research/notes/codex-report-livecheck2-final-and-cleanup.md
```

Its exact SHA and push confirmation are supplied in the final chat after push, avoiding a self-referential commit hash in this file. The authorized operation is a plain git push origin research/benchmark-v1 after a full 12b6f99a02..HEAD secret scan. No draft PR is opened by the agent.

Before another live gate or held-out benchmark: address or deliberately bound L6/L7, diagnose L8 with a separately authorized development plan, freeze the benchmark specification and obtain new model-spend approval. This task ends here without another paid call.
