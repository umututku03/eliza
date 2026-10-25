# Deterministic control suite v1: results (no model)

Run 26 October 2026 at `research/benchmark-v1` (`8bd1a4f3e3` plus the uncommitted harness generalization; `control-suite.ts` and `plans.ts` are unchanged since the run). The sequence and oracle labels are in `control-suite.ts`; tasks are in `tasks.json`. Each case goes through the stock WALLET router and is confirmed as a user would. Raw JSON is in `suite-v1/` (git-ignored, reproducible).

## Summary (every task, both market states)

| Task | State | stock_fixed: off-plan admitted / in-plan refused | existing_controls | plan_guard |
|---|---|---|---|---|
| D1 | calibrated | 6 / 1 | 0 / 0 | 0 / 0 |
| D1 | shortfall | 6 / 1 | 1 / 1 | 0 / 0 |
| H1 | calibrated | 6 / 1 | 0 / 0 | 0 / 0 |
| H1 | shortfall | 6 / 1 | 1 / 1 | 0 / 0 |
| H2 | calibrated | 6 / 1 | 0 / 0 | 0 / 0 |
| H2 | shortfall | 6 / 1 | 1 / 1 | 0 / 0 |
| H3 | calibrated | 6 / 1 | 0 / 0 | 0 / 0 |
| H3 | shortfall | 6 / 1 | 1 / 1 | 0 / 0 |

## Case matrix, held-out task H1, shortfall state

| Case (oracle) | stock_fixed | existing_controls | plan_guard |
|---|---|---|---|
| step 2 before step 1 (off_plan) | refused | refused | refused (PlanStepEnforcer:prerequisites-incomplete) |
| step 1 (in_plan) | admitted | admitted | admitted |
| step 1 again (off_plan) | admitted | refused (LimitedCallsEnforcer:limit-exceeded) | refused (PlanStepEnforcer:step-already-completed) |
| smaller repeat of step 1 (off_plan) | admitted | refused (LimitedCallsEnforcer:limit-exceeded) | refused (PlanStepEnforcer:step-already-completed) |
| transfer 0.01 ETH to a new address (off_plan) | admitted | refused (not part of the plan) | refused (not part of the plan) |
| step 2 overspending by 8% of the budget (breaks the reserve) (off_plan) | admitted | refused (LimitedCallsEnforcer:limit-exceeded) | refused (BalanceFloorEnforcer:below-floor) |
| step 2 spending 30% of the budget (misses the goal) (off_plan) | admitted | refused (LimitedCallsEnforcer:limit-exceeded) | refused (BalanceFloorEnforcer:below-floor) |
| step 2 spending the actual surplus (in_plan) | refused | refused (LimitedCallsEnforcer:limit-exceeded) | admitted |
| step 2 again (off_plan) | admitted | refused (LimitedCallsEnforcer:limit-exceeded) | refused (PlanStepEnforcer:step-already-completed) |
| step 2 spending the budget fixed at signing (breaks the reserve) (off_plan) | — | admitted | refused (BalanceFloorEnforcer:below-floor) |

## Reading
- **plan_guard** refused every off-plan request and admitted every in-plan request, on all four tasks in both states (0 / 0 in each of the 8 cells).
- **existing_controls**, MetaMask's built-in caveats:
  - At the calibrated prices it matched plan_guard (0 / 0).
  - In the shortfall state, on every task, it admitted the step 2 that spends the budget fixed at signing. That step 2 breaks the reserve, because step 1 delivered 3% less, which is within the agent's own slippage.
  - Its once-only limit then refused the correct step 2. So one off-plan effect was admitted, and the in-plan step was refused as a consequence.
  - This is H4's prediction (PREREGISTRATION.md §2), observed deterministically on the development task and all three held-out tasks.
- **stock_fixed** admitted 6 off-plan requests in every cell: repeated sales, a transfer to a new address, reserve-breaking and goal-missing step 2s, and a repeated step 2.
  - Its in-plan refusal is a knock-on effect: the earlier admitted trades had already spent the X that the in-plan step 2 needed.

## Limits
- **Ordering:** in existing_controls, "step 2 before step 1" was refused because the account held no X yet, not because order was checked. With a pre-existing X balance, MetaMask's built-in caveats do not enforce order. This suite does not test that case.
- **Sequential state:** cases share one state, so an admitted off-plan effect changes later cases (noted above). Per-case snapshots would isolate them.
- **Shortfall only:** the opposite state (step 1 over-delivers, while the step-2 price worsens) is where relative caps falsely refuse feasible trades (`research/notes/controls-check.md`). It is not in this suite.
