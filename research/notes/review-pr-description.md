# Draft review description

## Summary

A transacting agent can repeat a completed sale after losing its receipt, spend the wrong amount on the next step, or declare an outcome that differs from chain state. This research branch adds a pinned-fork harness and compares which effects reach the chain under an agent-held key, existing delegation controls and signed sequence-level plan enforcers. It also records the framework repairs required to make that comparison possible.

All live checks so far are development evidence. Checks 1 and 2 use r=1 per cell. In check 2 all four cells complete the chain task; three closing declarations are COMPLETED and one is unavailable after its cohort-budget refusal. One Luna/stock continuation still fails reply grounding. L6/L7 and the L8 startup observation are open, and the no-framework-error live gate is not met. These counts are not reliability rates.

## Structure and reading order

1. [OVERVIEW.md](../OVERVIEW.md): claim, setup, results, literature and supervisor questions.
2. [framework-changes.md](framework-changes.md): all 58 framework files since base 6b6df2f254, source commits, test pointers and unexplained gaps.
3. L1–L5 commits: 0bf39964e2 (asset visibility), 3972fbad47 (history and resolved-chain confirmations), 0e15b8cb4b (own-recipient equivalence), 13c9389b3f (holding-language exclusions), 2fed8141f6 (fresh recovery evidence). The [backlog](hardening-backlog.md) gives trace-backed status, including limitations.
4. [Harness](../agent-harness-v2/) and [protocol](../agent-harness-v2/protocol.md): execution, ledger, source binding, chain scoring and tamper rejection. Historical audits need their producing source version.
5. [Pre-registration draft](../benchmark/PREREGISTRATION.md), [control matrix](../benchmark/suite-v1-summary.md) and [enforcer tests](../plan-guard/README.md).
6. [Final report](codex-report-livecheck2-final-and-cleanup.md): exact validation, spend, preserved stop record and cleanup scope.

The framework diff includes hardening, replay fixtures and research wallet integrations. The map explicitly leaves analytics availability and mechanism commits without invented defect IDs. It also flags missing dedicated registration/wording and nested-planner replays. L6/L7 are observations, not fixes in this review cleanup.

## Validation

Pinned Node 24.15.0 / Bun 1.4.2. The recorded pre-cleanup baseline is core 382 passed / 2 known logger.native-esm environment failures, assistant 2743/2743, wallet 230 passed / 1 skipped, route 12/12, and five mock cells with PASS audits, 9/9 tamper rejections and zero deviations each. Post-cleanup unit counts and route checks match. One scheduled stock mock fails before creating a manifest (L8); no episode count can be assigned to it. The final report lists the five scheduled cells individually, rather than treating another stock cell as its replacement.

Four check-2 live audits PASS with 9/9 tamper rejections each. No live cell was retried or replaced. Check-2 spend is 0.288868450 USD; the cumulative ledger is 3.676216700 USD. Full comparisons and counting rules are in the [live-check note](live-check-2-2026-10-26.md).

Cleanup is limited to documentation, four research comments, seven proven-unused imports in the fork helper and an ignored audit-sidecar pattern. A duplicate helper header introduced during import cleanup was also removed. The changed comments transpile to identical JavaScript; the helper's executable body is unchanged. Raw traces/results and local-only test configuration stay untracked.

## Review scope

This is a draft for the user's fork, against research/v2-base. The mechanism is not audited, the benchmark pre-registration is not frozen, and the observed framework gaps remain open. Future held-out or finish-line live checks need separate approval.

No PR has been created. The user can create one after reviewing this description:

```bash
gh pr create --repo umututku03/eliza --base research/v2-base --head research/benchmark-v1 --draft
```
