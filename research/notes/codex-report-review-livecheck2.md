# Review and live check 2: final Codex report

**Status: stopped at Task A3's budget-refusal rule. Task B was not started.**

- Live source commit: `12b6f99a02`.
- Local record commit / current branch head: `277ddc5ebf` on `research/benchmark-v1`.
- Branch head after push: **not applicable; no push was performed after the stop**. Origin remains at `12b6f99a02`.
- New model spend: **0.170291200 USD**; cumulative ledger **3.557639450 USD**, below the approved cumulative ceiling **3.987348250 USD**.
- Two completed Haiku cells pass audit and 9/9 tamper checks. Both execute one sale and step 2 and meet goal/reserve. Haiku/plan_guard has one budget refusal. Both Luna cells remain unrun.

## Validation before the live check

The supplied scripts were reused through fresh-name copies to preserve old results and logs. Pinned Node 24.15.0 and Bun 1.4.2:

| Check | Before live check | After cleanup |
|---|---|---|
| Core | 382 passed / 2 known logger.native-esm environment failures, 384 total | Not run: cleanup not started |
| Assistant | 2743/2743, including the final-mock script's repeat suite | Not run |
| Wallet | 230 passed / 1 skipped, 231 total | Not run |
| Fork route control | All 12 checks true | Not run |
| final-checks mocks | D1 stock, D1 plan_guard, H1 existing_controls: PASS, 9/9 tamper per cell, 0 deviations | Not run |
| final-mock mocks | D1 stock and D1 plan_guard: PASS, 9/9 tamper per cell, 0 deviations | Not run |

These are the expected counts; no tests or framework behavior were changed. The only later execution was a read-only replay of the recorded L6 quote against the unchanged holding validator for diagnosis.

## Cleanup and file changes

Committed locally in `277ddc5ebf`:

- `research/agent-harness-v2/results-livecheck2-haiku-stock.audit.json`
- `research/agent-harness-v2/results-livecheck2-haiku-plan_guard.audit.json`
- `research/notes/live-check-2-2026-10-26.md`
- Appended the A4-required L6 evidence to `research/notes/hardening-backlog.md`.

This requested final report is written locally and is not staged. Raw runs, logs, private orchestration helpers and dryrun audit sidecars are not committed. The latter remain in place, including pre-existing untracked audit files; Task B's gitignore cleanup was not performed.

No research index rewrite, overview, 58-file change map, notes index, code/comment cleanup, dead-code removal, move, gitignore edit, post-cleanup validation or PR description was performed. The instruction to stop on a budget refusal takes precedence over Task B. No source file under packages/core or plugins changed. No issue, PR, comment, maintainer contact, history rewrite or push occurred.

Both completed result folders and their six sidecars were archived locally, verified byte-for-byte, and 231 hashes appended without changing any earlier checksum line.

## Full live-check analysis and comparison

# Live check 2 after L1–L5 — 26 October 2026 (UTC)

Source: `12b6f99a02`, clean `plugins/` and `packages/core`. Pinned Node 24.15.0 and Bun 1.4.2. Approved design: D1, normal, r=1, haiku/stock → haiku/plan_guard → luna/stock → luna/plan_guard. Cohort caps: 0.16, 0.16, 0.20, 0.20 USD. Starting ledger 3.38734825 USD; cumulative ceiling 3.98734825 USD.

## Stop and audit status

**Stopped at the required budget-refusal rule after the second cell.** Both completed cells have complete markers, child exit 0, PASS audits and 9/9 tamper rejections. Both executed one sale and step 2, and both meet the goal and reserve. Haiku/plan_guard has one refused_budget record: call 57, turn 5, wouldReserveUSD 0.0373236. It ends budget_exhausted; the closing declaration is UNPARSEABLE. No Luna cell was started, retried, replaced or fabricated. A reservation refusal does not mean the settled spend reached the numerical cohort cap: the proxy also accounts for in-flight reservations.

| Planned cell | Audit | Tamper | Calls / budget refusals | New USD | Cumulative USD |
|---|---|---|---:|---:|---:|
| haiku/stock | PASS | 9/9 | 47 / 0 | 0.074752400 | 3.462100650 |
| haiku/plan_guard | PASS | 9/9 | 58 / 1 | 0.095538800 | 3.557639450 |
| luna/stock | NOT RUN | NOT RUN | 0 / 0 | 0 | — |
| luna/plan_guard | NOT RUN | NOT RUN | 0 / 0 | 0 | — |

New spend: **0.170291200 USD**. Cumulative ledger: **3.557639450 USD**. No cap was exceeded. Both audited cells record 0 outside-turn refusals and no blocked hosts.

## Episode comparison from recorded traces

First check source: `2cca02b446`; second check source: `12b6f99a02`. Each row comes from its episode JSON, chain-scored outcome, complete ledger, saved request/response records and child stderr, not recollection. The first check's four audits are committed in `research/agent-harness-v2/results-livecheck-*.audit.json`; the new two are `results-livecheck2-haiku-stock.audit.json` and `results-livecheck2-haiku-plan_guard.audit.json`. Raw folders with the same stem stay local.

### First check

| Episode | Sales | Step 2 executed / input | Goal / reserve; final DAI / USDC | Declared / actual | End reason | Re-ask turns | Redacted total / assets | Earlier-hash tx_status | RGF | EVAL | Spend USD |
|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|
| haiku/stock | 1 | 0 / none | no / yes; 0 / 237.636476 | UNPARSEABLE / incomplete | budget_exhausted | 0 (none) | 850 / 680 | 0 | 1 | 0 | 0.117394400 |
| haiku/plan_guard | 1 | 0 / none | no / yes; 0 / 237.636476 | UNPARSEABLE / incomplete | max_user_turns | 2 (2, 5) | 388 / 380 | 0 | 0 | 0 | 0.092965700 |
| luna/stock | 1 | 1 / 59.406476 USDC | yes / yes; 59.046981018462803274 / 178.23 | IN_PROGRESS / chain complete | max_user_turns | 1 (2) | 294 / 279 | 0 | 0 | 0 | 0.079787125 |
| luna/plan_guard | 1 | 1 / 58 USDC | yes / yes; 57.649042426416322899 / 179.636476 | IN_PROGRESS / chain complete | max_user_turns | 2 (2, 5) | 329 / 313 | 0 | 0 | 0 | 0.078040125 |

### Second check

| Episode | Sales | Step 2 executed / input | Goal / reserve; final DAI / USDC | Declared / actual | End reason | Re-ask turns | Redacted total / assets | Earlier-hash tx_status | RGF | EVAL | Spend USD |
|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|
| haiku/stock | 1 | 1 / 40 USDC | yes / yes; 39.758191512505224943 / 197.636476 | COMPLETED / chain complete | max_user_turns | 0 (none) | 20 / 0 | 1 | 0 | 0 | 0.074752400 |
| haiku/plan_guard | 1 | 1 / 59.077 USDC | yes / yes; 58.719505074839409964 / 178.559476 | UNPARSEABLE / chain complete | budget_exhausted | 1 (1) | 18 / 0 | 1 | 0 | 0 | 0.095538800 |
| luna/stock | — | NOT RUN | — | — | Budget stop before cell | — | — | — | — | — | 0 |
| luna/plan_guard | — | NOT RUN | — | — | Budget stop before cell | — | — | — | — | — | 0 |

### Counting rules

- RGF/EVAL are exact REPLY_GROUNDING_FAILED / EVALUATOR_INVALID_OUTPUT occurrences in child stderr.
- A re-ask is a confirm turn with zero new transactions and a recorded requiresConfirmation=true result. This is an observed flow count, not attribution to an argument-binding bug. First-check Haiku/stock also spent confirm turn 3 on quotes without a pending confirmation result; it is not counted as an explicit re-ask. First-check Luna/plan_guard's turn-5 duplicate-sale refusal is included in its observed count, not attributed to the alias bug.
- Redacted values are literal occurrences summed across saved request bodies, including repeated history and error text. Assets counts explicit fromToken/toToken/token/tokens fields only. In check 2 all remaining 20/18 occurrences are key fields; no asset field is masked. The first Haiku/stock maximum was 62 per request; check 2 maxima are 1.
- Earlier-hash tx_status requires a real recorded transaction hash submitted in a strictly earlier user turn. Same-turn receipt checks do not count. New calls 32 (stock, turn 2) and 39 (plan_guard, turn 3) verify the earlier sale.
- UNPARSEABLE means no parseable closing declaration. In new plan_guard, turn 3 already said both trades completed; budget exhaustion prevented the later closing response.
- These are development checks at one repetition per cell, not reliability rates or a held-out evaluation.

## L1–L5 verdicts

| Item | Verdict from live check 2 | Recorded evidence |
|---|---|---|
| L1 | Fixed in exercised asset fields. Credential-shaped key fields remain masked as intended. | Stock calls 12/13/15 request bodies and plan_guard calls 22/24/25: remaining mask field is key; all saved requests have 0 masked asset fields. Both step-2 calls execute with real token addresses. |
| L2 | Fixed in exercised cross-turn path. | Stock call 32, turn 2: tx_status uses the sale hash from turn 1. Plan_guard call 39, turn 3: uses the sale hash from turn 2. Responses and action results report succeeded. |
| L3 | L3a fixed in exercised chain-alias path; L3b recipient variation not exercised. One different re-ask remains. | Plan_guard call 17 proposes execute on mainnet; call 21 executes the approved sale on ethereum in the next turn. Turn 1's extra ask follows a prose-only request in turn 0 (call 13 response), after dry-run/simulate only; it had not armed the real pending gate. This is not a demonstrated recurrence of the alias/recipient binding defect. |
| L4 | Still present for another quote shape; recorded as L6 below. | Plan_guard call 11 response: quote paragraph ends “58.13 minimum”. Call 13 request explicitly says the prior draft failed financial_holding; call 13 rewrites it and call 14 accepts grounding. A direct read-only replay through the unchanged current validator reproduces rejection of that quote fragment. |
| L5 | Not exercised after a trade. | Stock has no recovery-compose request; the only new plan_guard recovery-compose call is 13 in turn 0, before any transaction. No post-trade recovery snapshot was exercised. Zero final RGF does not prove this repair live. |

Paths above are under `research/agent-harness-v2/results-livecheck2-haiku-{stock,plan_guard}/llm/calls/<n>-request.json` or `<n>-response.json`, with turns in the matching episodes JSON.

## New defect: L6, non-asset quote label read as a holding

In plan_guard call 11 the agent describes a quote: “a 59.077 USDC test quote returned about 58.72 DAI expected, 58.13 minimum.” The current holding validator rejects that text. The comma-separated fragment “58.13 minimum” fits its standalone quantity/symbol rule; minimum is treated as an asset label rather than a quote qualifier. Call 13 request records financial_holding as the reason, and calls 13–14 repair the reply. This is a remaining L4 mechanism, not an additional final RGF event. It costs internal recovery work in the same user turn. No fix was made. See `plugins/plugin-assistant/src/services/message/financial-observations.ts` (holdingClaims/financialHoldingIsUngrounded).

The prose-only confirmation handoff is also recorded for follow-up, without calling it a proven regression in the normalized binding fix. The guard correctly requires an actual pending authorization.

## Preservation and invocation record

Both completed directories, console logs, audits and tamper logs were copied to the local `eliza-v2-run-archive/agent-harness-v2/`. All copies match their sources. Exactly 231 checksum lines were appended to the archive-root SHA256SUMS, preserving the original 1,324,097 bytes unchanged. No missing Luna artifacts were fabricated.

The supplied validation scripts reused existing output names, so copies used fresh review-pre destinations and filtered output. Before spending: core 382 passed / 2 known logger.native-esm environment failures, assistant 2743/2743, wallet 230 passed / 1 skipped, route 12/12, five required mock cells PASS, each 9/9 tamper rejected and 0 deviations. The independent baseline guard confirmed the exact counts.

The first live invocation used fail-fast shell mode, which exited after the successful first cell because the supplied run function ends in a false run-error predicate. The first experiment was complete and audited; it was not rerun. Its exact run function was reused for the remaining approved cells with prior taken from that marker, and an external guard stopped before Luna as soon as the second cell's budget refusal was seen. All wrapper logs are retained locally. The requested live-check-2.sh copy contains only the specified edits.

## Deferred work

Task B was not started: no index rewrite, overview, framework map, notes cleanup, code hygiene, gitignore change, post-cleanup validation, PR description or push. The Task A3 stop rule takes precedence. L6 is listed, not fixed. The live finish line remains unestablished for both models, and L4 remains open. No upstream issue/PR/comment or maintainer contact occurred.
