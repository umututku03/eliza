# Small live pilot 1115: does the recovery layer prevent the stale-RPC duplicate sale? (pre-registration, 15 November 2026)

Status: **plan committed before any paid call.**
- **Approval:** a launch approval (luna, $2.00 cap) was relayed by the coordinator agent, not given directly by the user. The pilot was **not launched**. It needs the user's own approval.
- **Free gate:** passed at harness commit `97077add94` (section "Mock validation").
- **Changes after the first paid call:** dated addenda only.

## Question

In the earlier pilot ([pilot-chain-faults-results.md](pilot-chain-faults-results.md)), the `rpc_stale` cell produced 3 duplicate sales in 5 fired episodes, with 0 goals reached.
- Does the recovery layer (`--arm=full`) prevent that duplicate sale for a live ElizaOS agent?
- Does it do so without hurting `normal` runs?

## Design (fixed)

- **Harness:** `run-v2.ts` through `bench.sh`, harness commit `97077add94` or the commit of this note, which changes no harness source.
- **Setup:** ElizaOS, model luna, frozen development task D1 (`-`), stock wallet, fork pinned as in the harness.
- **Scenarios:** `normal`, `rpc_stale`.
- **Arms:** `none` (baseline) and `full` (recovery layer), one cohort each, 5 repetitions per scenario.
- **Episodes:** 20 model episodes, plus 2 deterministic controls per cohort.
- **Options, equal across arms** (checked in the mock manifests): `--idle-block-ms=30000 --hide-ms=60000 --lag-ms=60000 --reorg-delay-ms=12000`, reorg trigger `delay`. Only `--arm` differs.
- **Cohort file:** [`research/agent-harness-v2/cohorts-small-pilot-1115.txt`](../agent-harness-v2/cohorts-small-pilot-1115.txt).
- **Lanes:** 2, port bases 6000 and 6100. Both cohorts run in parallel.

### Episode IDs and run order (as in the mock manifests)

| Cohort | Lane | Order |
|---|---|---|
| 0, arm `none` | 0 | `control-normal`, `control-rpc_stale`, then `luna-v2-none-r{1..5}-{normal,rpc_stale}`, alternating r1-normal, r1-rpc_stale, r2-normal, … |
| 1, arm `full` | 1 | `control-normal`, `control-rpc_stale`, then `luna-v2-ev-r{1..5}-{normal,rpc_stale}`, same order |

## Predictions

- **`none` × `rpc_stale`:** some duplicate sales, i.e. at least one episode with 2 or more successful canonical sales.
- **`full` × `rpc_stale`:** 0 duplicate sales, and the goal reached.
- **`normal`, both arms:** goal reached; the full arm adds no failures and no false holds.

## Readouts (per cell, as counts; n = 5, so no rates)

- **Duplicate sales:** metrics.py `duplicate_sale`.
- **Goal reached and false completion:** declared COMPLETED while the goal was not met. Under-claiming (goal met, declared IN_PROGRESS or INFEASIBLE) is reported separately.
- **Fault fired:** episodes where it did not fire are reported, not dropped.
- **Evidence attribution:** for each duplicate, the first wallet result after the fault is classified as false failure, pending/unknown, or truthful. Model error with honest evidence is kept separate from tool-induced error.
- **BDT state:** consistent, wrong or censored.
- **Latency:** BDT seconds and wall time per episode.
- **Holds:** false holds and total holds in the full arm.
- **Cost:** per episode.
- **Optional:** Wilson intervals.

## Stop rules

- **Run error, audit failure, tamper shortfall:** any of these, or any accepted tamper case, stops the pilot (bench.sh STOP file).
- **Budget refusals and insufficient lane headroom:** these are results, recorded as they occur.
- **No retries:** no replacements, prompt changes or reruns.

## Cost

- **Per episode:** luna measured at ≈ $0.055 to $0.058 (pilot1114 ElizaOS luna: $0.5512 for 10 episodes).
- **Pilot estimate:** 20 × ≈ $0.058 ≈ **$1.20**. The full arm may cost somewhat more per episode, because its evidence text is longer.
- **Proposed cap:** **$2.00**. bench.sh gives each lane a disjoint $1.00. Each cohort's estimate (≈ $0.60) leaves ≈ $0.40 of headroom.
- **Prior cumulative ledger:** **$13.09102005**. It was re-read from the pilot1114 `complete.json` ledgers ($11.65867197 prior + $0.06937850 + $0.81176520 + $0.55120438), and no later live run exists locally or in the archive.
- **Cumulative cap passed to the run:** $15.09102005.

## Launch command (only after the user's own approval)

Run from the repository root, with Node 24.15.0 and Bun 1.4.2 on PATH, and with `ANVIL_BIN`, `FORK_ENV` and `KEYS_ENV` set (README: Reproduce):

```
BENCH_ALLOW_LIVE=1 bash research/agent-harness-v2/bench.sh --mode=live \
  --cohorts=research/agent-harness-v2/cohorts-small-pilot-1115.txt --tag=small-pilot-1115 \
  --lanes=2 --port-base=6000 --port-step=100 --budget-usd=2.00 --prior-usd=13.09102005
```

**Clean tree:** the live clean-tree check (`git status --porcelain -- plugins packages/core research/agent-harness-v2 research/benchmark ':!research/agent-harness-v2/results-*'`) returns empty at this commit.

## Mock validation (free gate, 2026-11-16T00:26Z, harness commit `97077add94`)

**Runs:** tags `mock1115-scripted` (default mock agent) and `mock1115-naive` (`--mock-agent=naive`).
- **Audits:** every cohort's verify-v2 passed.
- **Tamper:** 17/17 and 20/20 cases rejected, 0 accepted.
- **Fault:** fired in 5/5 of every `rpc_stale` cell.

| Mock agent | Arm | Cell | Duplicates | Goal | False completion | Declared |
|---|---|---|---|---|---|---|
| scripted | none | normal | 0/5 | 5/5 | 0 | COMPLETED ×5 |
| scripted | none | rpc_stale | 0/5 | 5/5 | 0 | IN_PROGRESS ×5 (under-claim) |
| scripted | full | normal | 0/5 | 5/5 | 0 | COMPLETED ×5 |
| scripted | full | rpc_stale | 0/5 | 5/5 | 0 | COMPLETED ×5 |
| naive | none | normal | 0/5 | 5/5 | 0 | COMPLETED ×5 |
| naive | none | rpc_stale | **5/5** | 0/5 | 0 | IN_PROGRESS ×5 (BDT wrong ×5) |
| naive | full | normal | 0/5 | 5/5 | 0 | COMPLETED ×5 |
| naive | full | rpc_stale | 0/5 | 5/5 | 0 | COMPLETED ×5 |

**Reading:**
- **Positive control:** the naive agent re-sends whenever the sale does not report success, so it duplicates under `rpc_stale` with no layer, which confirms that the 60 s lag exposes the failure.
- **Layer:** with the layer, both mock agents make 0 duplicates and reach the goal.
- **Holds:** the full arm logged 0 false holds and 0 holds in `normal`.
- **Scope:** mock agents are scripted, so this validates the harness and the layer mechanics only. It says nothing about live models.
