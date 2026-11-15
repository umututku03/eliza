# Chain-fault pilot: results (15 November 2026)

Status: 2026-11-15. Results of the pre-registered pilot ([pilot-chain-faults-plan.md](pilot-chain-faults-plan.md)). **Counts, not rates** (r = 2).

## Run record
- **Run:** tag `pilot1114`, harness commit `cb99c39736`, started 2026-11-15T01:06Z. Three lanes in parallel: ElizaOS luna, ElizaOS haiku, agent2 luna.
- **Episodes:** 30, plus 15 deterministic controls.
- **Audits:** every cohort PASS, 0 tamper cases accepted (11, 11 and 12 rejected).
- **Spend:** **$1.43234808** new, against the $3.00 ceiling. Cumulative ledger **$13.09102005**.
- **Changes:** no retries, replacements or prompt changes.
- **Archive:** raw folders in `eliza-v2-run-archive`, 2,522 files, with SHA-256 hashes appended and verified. Audit JSONs are committed with the local path prefix stripped.

## Outcome
| | Goal reached |
|---|---|
| `normal` (no fault) | **5 / 6** |
| fault episodes **where the fault fired** | **5 / 20** |

**Faults that did not fire (4 of 24), reported and not dropped:**
- `luna-v2-r1-sale_dropped` and `luna-v2-r2-rpc_stale`: the agent never sold, so the fault never armed.
- `luna-a2-r1/r2-sale_reorged`: agent2 finished within the 20 s reorg delay. WS-R adds the next-send trigger for this.

**Per fault cell (fired episodes):**
| Cell | Fired | Goal | Duplicate sales | Final declarations |
|---|---|---|---|---|
| receipt_hidden (landed; evidence missing) | 6 | 4 | 0 | all IN_PROGRESS (under-claiming) |
| **rpc_stale** (landed; evidence misleading) | 5 | **0** | **3** | IN_PROGRESS ×3, INFEASIBLE ×2 |
| **sale_dropped** (not landed; evidence missing) | 5 | **1** | 0 | IN_PROGRESS ×4, COMPLETED ×1 |
| **sale_reorged** (not landed; evidence misleading) | 4 | **0** | 0 | **INFEASIBLE ×4**: every agent gave up instead of re-sending |

## Decision rule (pre-registered) → **SCALE UP**
- **(a) holds.** 3 duplicate sales in a landed cell (all in rpc_stale). Two came after ElizaOS's false "failed". **One came from agent2 with honest "pending" evidence**, so it was the model's own wrong choice. The rule counts only the last kind, and one is enough.
- **(b) holds.** 9 not-landed episodes fired. 7 ended with no successful re-send. Of those, 3 (33%) stalled or claimed completion, against a 25% threshold. The other 4 declared INFEASIBLE, a premature give-up, which the literal rule does not count. Counting them gives 78%.
- **(c) does not hold.** 3 of 30 episodes (10%) have a wrong BDT status. Most failures are censored (stalls), not wrong.

## What the pilot shows (provisional; small n)
1. **Chain faults sharply reduce completion:** 5 of 20 fired fault episodes completed, against 5 of 6 with no fault.
2. **Stale reads cause duplicate sales,** including one with honest tool evidence (agent2). The model, not only the framework, makes the wrong call.
3. **After a reorg, agents give up:** 4 of 4 declared INFEASIBLE instead of re-sending the safely re-sendable sale.
4. **Dropped transactions cause stalls:** agents rarely re-send.
5. **ElizaOS reports false failures** in receipt_hidden and rpc_stale, confirming the WS-A finding on live models.

## Notes for the main study
- **Reorg trigger:** use the next-send trigger, or the 12 s delay grounded in the realism data, so fast agents are exposed.
- **Baseline misreports:** `normal` had one failure (`haiku-v2-r2-normal`) and one goal-met-but-declared-INFEASIBLE (`luna-v2-r2-normal`). Report baseline misreporting alongside the fault effects.
