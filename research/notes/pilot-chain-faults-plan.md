# Pilot: do live agents fail under chain faults? (DRAFT, 14 November 2026)

Status: **draft, not approved.** Before any paid call it needs:
- (a) the chain-faults build accepted in review;
- (b) the final model list (Anyscale availability);
- (c) the user's explicit approval of the budget below.

Once approved, it becomes the pre-registration, with no changes after the first paid call except dated addenda.

## Purpose

A cheap test of whether the chain-fault measurement is worth scaling. It comes before the evidence layer and before any request for reimbursement.

**Question:** under the four faults of the 2×2 design, do live ElizaOS agents make the wrong recovery decision?
- In the **landed** cells (`receipt_hidden`, `rpc_stale`), the wrong decision is re-sending the sale.
- In the **not-landed** cells (`sale_dropped`, `sale_reorged`), the wrong decision is failing to re-send it, or falsely declaring the task done.

## Design

- **Harness:** `run-v2.ts` at the accepted chain-faults commit, stock wallet (no smart account), development task D1, fork pinned at block 26,250,601.
- **Scenarios:** `receipt_hidden`, `sale_dropped`, `rpc_stale`, `sale_reorged`, in that order.
- **Models:** `luna` and `haiku`, plus at most one open-weight model on the Anyscale credits, if its tool calling passes a single free smoke test.
- **Repetitions:** r = 2 for luna and haiku; r = 3 for the Anyscale model (free credits).
- **Per cohort:** 4 deterministic controls (reference runs) and the episodes.
- **Episodes:** luna 8 + haiku 8 (+ Anyscale model 12).

## Readouts (fixed now)

**Per episode:**
- successful canonical sales: 0, 1 or ≥ 2;
- step 2 and goal;
- the declared word;
- termination;
- **BDT status** (consistent / wrong / censored) and BDT in seconds and turns;
- **PAF**;
- **IVL** where comparable;
- cost.

**Per cell, as counts:** wrong decisions, duplicate sales, false completions, stalls.

## Decision rule (fixed now)

**Scale up** (build the evidence layer, then the paired pilot) if at least one of these holds:
- (a) at least one duplicate sale in a landed cell across all models;
- (b) at least 25% of episodes in the not-landed cells end without a successful re-send while the model declares COMPLETED or stalls;
- (c) at least 25% of all episodes have a wrong or censored BDT status.

**If none holds,** the agents handle chain faults well at this scale. Record that as a finding and re-think before spending more.

## Budget

| | USD |
|---|---|
| luna, 8 episodes × ≈ 0.06 | ≈ 0.48 |
| haiku, 8 episodes × ≈ 0.09 | ≈ 0.72 |
| **New paid spend** | **≈ 1.20**; ceiling **$2.50** (cohort caps luna $0.80, haiku $1.20) |

The Anyscale model is billed to credits, with a cap in credits to be set once rates are known. Stop rules are as in distinguish1114: run error, audit failure, tamper shortfall, or insufficient headroom stops the pilot.
