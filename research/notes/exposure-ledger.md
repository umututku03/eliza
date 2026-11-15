# Exposure ledger (15 November 2026)

Status: 2026-11-15. Codex's readiness addendum asks for this before a protocol freeze: for every task, fault and parameter, how it has been used. Built from every result-folder manifest in the local run archive and the worktrees (mode, task, scenarios).

## Kinds of exposure
- **Live outcome:** real LLM episodes whose behaviour we have seen. These can bias design choices.
- **Mock functional QA:** scripted agents (mock plan, naive re-sender) and deterministic controls, used to test that the harness, faults and verifier work. They reveal nothing about model behaviour.
- **No-model matrix:** the deterministic compromised-agent matrix (scripted attacker), run on all four tasks on 26 Oct 2026.
- **Calibration:** task amounts derived at the pinned block (`calibrate-tasks.ts`), plus evidence-layer constants (K = 2, 5 s checks, a 60 s budget, 6 rounds).

## Ledger
| Task | Fault / scenario | Live outcome (folders) | Mock functional QA | Other |
|---|---|---|---|---|
| **D1** | normal | **yes** (28: Oct dev/live-check/sweep, Nov 14 sweep, pilot) | yes | matrix |
| D1 | receipt_hidden | **yes** (13: Oct sweep + pilot) | yes | — |
| D1 | price_change_feasible / _infeasible | **yes** (8 each: Oct sweep) | yes | — |
| D1 | pre_sale_shortfall, prefunded, price_worse | **yes** (6 each: Nov 14 sweep) | yes | matrix |
| D1 | **rpc_stale, sale_dropped, sale_reorged** | **yes** (3 each: pilot, 15 Nov) | yes | — |
| D1 | stale_then_price, dropped_then_reorg | no | yes | — |
| D1 | sale_reorged_reincluded | no | yes (WS-R, in progress) | — |
| **H1** (DAI→USDC) | normal, price faults, receipt_hidden, the 3 chain faults | **no** | yes (dry runs; WS-B) | matrix; calibration |
| **H2** | the same | **no** | yes (dry runs; WS-B) | matrix; calibration |
| **H3** (block 26,100,000) | receipt_hidden, the 3 chain faults | **no** | yes (WS-B) | matrix; calibration |
| A1, L1 (new workflows) | all | **no** | WS-W, in progress | calibration (WS-W) |

## Evidence-layer calibration exposure
- **Layer constants** (K, t, T, N) were set in the spec on 14 Nov, **before any live outcome under the chain faults**. They were not tuned on the pilot.
- **The idle-block producer (30 s)** was set during mock validation.
- **The offline replay** (Codex) used the pilot's real D1 traces. The layer **logic** was not changed in response, apart from Codex's correctness fixes for ambiguous broadcasts and the reorg landed-evidence reset. Those were found by tests, not by model outcomes.
- **Rule from here:** no layer constant or decision rule changes after a held-out live outcome is seen, except by dated addendum with a fresh partition.

## Consequence for the main-study claims
- **D1 is the development set.** It has live exposure on every fault.
- **H1–H3, the compound faults, the re-inclusion reorg and the new workflows have no live-outcome exposure.** They have been used only for mock functional QA and calibration of task amounts.
- **The paper says this precisely.** "Never used" is too strong. "No live model outcomes were observed on them before the protocol was frozen" is accurate.
