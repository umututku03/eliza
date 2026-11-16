# Small live pilot (15–16 Nov 2026): results

Pre-registered in `small-pilot-1115-plan.md` (commit 47076adcc6). Run at harness commit 47076adcc6 with
`bench.sh --mode=live`, tag `small-pilot-1115`. Model luna, ElizaOS, task D1 (development task, live-exposed before),
condition stock. Fault settings were equal across arms: idle blocks 30 s, stale-RPC lag 60 s. The user approved
a $2.00 cap on 15 Nov.

## Integrity
- Cohort 0 (arm `none`): verify-v2 PASS, 16/16 tamper cases rejected.
- Cohort 1 (arm `full`): verify-v2 PASS, 19/19 tamper cases rejected.
- New spend: $1.02905750 ($0.54015337 + $0.48890412). Cumulative ledger: $14.12007755.
- Raw folders (1,804 files) are archived in `eliza-v2-run-archive/small-pilot1115/`, with SHA-256 hashes appended to `SHA256SUMS`.
- Path-stripped audits: `research/agent-harness-v2/results-small-pilot-1115-{0,1}.audit.json`. Scorecard: `small-pilot-1115-scorecard.md`.

## Outcomes (n = 5 per cell)
| arm | cell | duplicate sale | goal reached | false completion | correct decision |
|---|---|---|---|---|---|
| none | normal | 0/5 | 4/5 | 0/5 | n/a |
| none | rpc_stale (fault fired 5/5) | **3/5** | 2/5 | **2/5** | 3/5 |
| full | normal | 0/5 | 4/5 | 0/5 | n/a |
| full | rpc_stale (fault fired 5/5) | **0/5** | **5/5** | 0/5 | 5/5 |

- **Predictions:** the plan predicted some duplicates for none under rpc_stale and 0 for full with the goal reached. Both held.
- **Normal runs:** each arm missed the goal once, through the agent's own step-2 choice. In the none arm this was an undersized buy (`goal_miss_after_trade`). There were no duplicates in either arm.
- **What the layer returned (full arm, rpc_stale; from the `[evidence-decision]` stderr lines):** every decision in all 5 episodes was `confirmed`, at both `send` and `check` sites. The layer kept polling inside the send call until fresh reads showed the sale with K = 2 confirmations, then reported success. The agent never received the stale "failed" or "pending" answer the baseline saw. Evidence attribution was consistent in 5/5. Latency and RPC overhead were not measured in this pilot.

## How to read this
- The sample is small: 3/5 against 0/5 is a demonstration, not a significance result. Fisher's exact test, one-sided, gives p ≈ 0.08.
- D1 is the development task, and one fault and one model were tested. Reorgs, dropped transactions, held-out tasks and other models remain open.
- The measured live failure (duplicate sales and false "done" under a stale read) and its absence with the layer match the mock and formal results.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
