# Overnight report, 26 October 2026 (00:50–05:00 EDT)

Status: 2026-10-26 — current. For the user. The supervisor-facing summary is [`../OVERVIEW.md`](../OVERVIEW.md); the draft PR is umututku03/eliza#1.

## Done

| Item | Result | Where |
|---|---|---|
| Compromised-agent matrix (new, no model) | plan_guard: 0/244 off-plan admitted, 0/44 legitimate refused. Built-ins: 16 and 4. Per-tx policy: 64 and 4. Ablations show both enforcers are needed. | `benchmark/matrix-v2-summary.md` |
| Same-state gas | plan_guard's sale equals LimitedCalls; its step 2 is 56k cheaper than the built-in plan | same |
| Plan-authoring probe ($0.10) | 3 of 4 models correct 36/36; GPT-4.1-mini left step 2's input asset open in 9/12 | `benchmark/plan-authoring-summary.md` |
| Fault sweep, ElizaOS ($5.29, 59 episodes, 10 audited cohorts) | Stock: 15 unsafe effects on chain. Built-ins and plan_guard: 0. No legitimate step refused. | `notes/dev-sweep-2026-10-26-results.md` |
| Reference agent, no framework ($0.12) | 31/32 correct. The one mistake was contained only by plan_guard. | `benchmark/reference-agent-summary.md` |
| New framework findings | A11 (Sonnet and Opus 5.5 reject forced tool choice; fixed `5fd56e8e4d`); A12 (GPT-6.1 Sol can't use tools via Chat Completions; open) | `notes/hardening-backlog.md` |
| Paper draft | IEEE format, all sections; no placeholders left | `paper/main.tex` |
| Validation at the final head | Unit suites unchanged (core 382 + 2 known environment failures, assistant 2,743, wallet 230 + 1 skipped, anthropic 29). Route 12/12. Mock D1 stock and plan_guard PASS, 9/9 tamper rejected, 0 deviations. | — |

## Things that went wrong (all recorded, none hidden)

- **Matrix oracle mislabel.** B2 was labelled off-plan by name. Fixed to constraint-based labels; the attempt is kept.
- **Matrix H1 crash** on token decimals. Fixed. Reruns of the other tasks were byte-identical.
- **Two sweep stops from tamper-test bugs** (a no-op edit; an episode with nothing to edit). Fixed; all cohorts pass 9/9. Cohorts 8–10 ran after the first stop, and no cohort was rerun.
- **Sonnet 5.5 episodes truncated** by the proxy's worst-case reservation (64k output tokens at $10/M). Needs a fix before held-out runs.
- **Analysis bugs fixed before reporting:** the harness's combined goal flag, and a reserve "breach" with no X.
- **The external LaTeX compiler download was blocked** by the auto-mode safety check. Compile the paper on Overleaf.

## Spend

About $3.06 Anthropic and $2.45 OpenAI tonight, within the $8 and $6 you approved. The cumulative harness ledger is $8.97.

## Decisions for you

1. **Look at the PR and the overview, then send them to Srisht.**
2. **Next paid step:** fix the reservation, then run Sonnet properly (~$3). Or hold the budget for the held-out runs.
3. **A second real framework** (AgentKit or GOAT)? The reference agent already gives a framework-free comparison.
