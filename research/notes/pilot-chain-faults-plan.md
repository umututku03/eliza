# Pilot: do live agents fail under chain faults? (pre-registration, 14 November 2026)

Status: **approved and pre-registered on 2026-11-14,** committed before the first paid call.
- **Approval:** the user approved the pilot with a $3.00 ceiling ("yes run them").
- **Free gate passed at this commit:** mock rehearsal of all three cohorts plus validation runs (`results-gate-*`); every audit PASS, 0 tamper cases accepted.
- **Models:** ElizaOS luna and haiku, agent2 luna. The Anyscale model is not included (no account details yet); it can be added later as a dated addendum.
- **Launch:** `research/agent-harness-v2/pilot-chain-faults.sh`, three lanes in parallel on disjoint ports.
- **Changes after the first paid call:** only as dated addenda.

## Purpose

A cheap test of whether the chain-fault measurement is worth scaling. It comes before the evidence layer and before any request for reimbursement.

**Question:** under the four faults of the 2×2 design, do live ElizaOS agents make the wrong recovery decision?
- In the **landed** cells (`receipt_hidden`, `rpc_stale`), the wrong decision is re-sending the sale.
- In the **not-landed** cells (`sale_dropped`, `sale_reorged`), the wrong decision is failing to re-send it, or falsely declaring the task done.

## Design

- **Harness:** `run-v2.ts` at the accepted chain-faults commit, stock wallet (no smart account), development task D1, fork pinned at block 26,250,601.
- **Scenarios:** `normal` (no fault: each agent's own paired baseline, per ICBC reviewer expectations), then `receipt_hidden`, `sale_dropped`, `rpc_stale`, `sale_reorged`, in the predeclared order.
- **Models:** `luna` and `haiku`, plus at most one open-weight model on the Anyscale credits, if its tool calling passes a single free smoke test.
- **Agents (advisor review, 14 Nov):** ElizaOS for all models. **agent2** (the minimal loop) × luna × the 4 faults × r = 2 is the early test of framework dependence; agent2 supports only the OpenAI format, so the Anyscale model covers its second model.
- **Repetitions:** r = 2 for luna and haiku; r = 3 for the Anyscale model (free credits).
- **Per cohort:** 4 deterministic controls (reference runs) and the episodes.
- **Episodes:** ElizaOS luna 10 + haiku 10, agent2 luna 10 (+ the Anyscale model 15). The 2 per cohort beyond the faults are the `normal` baseline.

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

- **evidence quality**: the first wallet result after the fault, classified as truthful, false failure (the tool said the swap failed although it landed), or pending/unknown. **Every wrong decision is attributed** either to the tool's false evidence or to the model choosing wrongly despite honest evidence. The two are reported separately and never pooled.

**Per cell, as counts:** wrong decisions (by attribution), duplicate sales, false completions, stalls, censored-by-timeout.

## Decision rule (fixed now)

**Scale up** (build the evidence layer, then the paired pilot) if at least one of these holds. Revised after advisor review; frozen before the first paid call.
- (a) at least one duplicate sale in a landed cell **where the tool's first evidence was not a false failure**. Duplicates after a false "failed" are reported separately as a framework finding.
- (b) at least 25% of episodes in the not-landed cells end without a successful re-send while the model declares COMPLETED or stalls;
- (c) at least 25% of all episodes have a **wrong** BDT status. Episodes censored only because the turn or wall-clock limit ended them are counted separately and do not trigger scale-up.
- **Limits, fixed:** 6 user turns as before. Each turn's wall clock is bounded by the fault windows (200 s lag or hide, 20 s reorg delay); no extra timeout.

**If none holds,** the agents handle chain faults well at this scale. Record that as a finding and re-think before spending more.

## Budget

| | USD |
|---|---|
| luna, 10 episodes × ≈ 0.06 | ≈ 0.60 |
| haiku, 10 episodes × ≈ 0.09 | ≈ 0.90 |
| agent2 luna, 10 episodes × ≈ 0.03 | ≈ 0.30 |
| **New paid spend** | **≈ 1.80**; ceiling **$3.00**, as approved (cohort caps: ElizaOS luna $0.90, haiku $1.40, agent2 luna $0.50; the script lowers each to the remaining sweep headroom) |

The Anyscale model is billed to credits, with a cap in credits to be set once rates are known. Stop rules are as in distinguish1114: run error, audit failure, tamper shortfall, or insufficient headroom stops the pilot.
