# WS-B report: benchmark extension (14 November 2026)

Status: 2026-11-14.
- **Written by:** the WS-B subagent. The harness blocked it from writing report files, so the coordinator committed its returned text, condensed.
- **Branch:** `ws/benchmark`, final commit `8f405763a1`.
- **Cost:** mock only, `newUSD` 0 everywhere.
- **Re-verified by the coordinator:** H1 audit PASS with 11/11 tamper rejections, the D1 compound fault PASS with 12/12, and the default regression PASS with 10/10.

## Status
| Item | Result |
|---|---|
| 1. `--port-base` | Done. Five mock cohorts ran at once on bases 1100–1500, all audit PASS. Includes a busy-port guard and child work folders separated per process. |
| 2. Four tasks | Done. Controls reached their labels on D1, H1, H2 and H3 × four chain faults. Nothing task-specific was hard-coded. |
| 3. Compound faults | `stale_then_price` PASS on D1 (12/12). **`dropped_then_reorg` blocked:** the runner, mock and verifier work, but the deterministic control needs a `control-child-v2.ts` change (patch 2). |
| 4. Fault parameters | Flags recorded in `manifest.faultParams` and checked by the verifier. **Non-default values are refused** until `fork-rpc-proxy.ts` accepts parameters (patch 1). |
| 5. `scorecard.py` | Done; prints for all 16 mock folders (markdown and `--json --by-task`). |
| 6. `bench.sh` | Done (bash 3.2). Parallel lanes with disjoint port bases and caps; audit plus tamper per cohort; STOP on any failure. Live mode is refused unless `BENCH_ALLOW_LIVE=1` together with a budget, prior and keys. |

## Acceptance (harness at `1c48c53eee`; later commits touch only bench.sh and the verifier/tamper scripts, which are not hashed)
- **Four tasks × four chain faults, stock, luna** (`bench.sh --tag=wsb-acc2 --lanes=5 --port-base=1100`):
  - all controls and episodes end `sales=1 step2=1 goal=true COMPLETED`;
  - each cohort audits PASS with 11/11 tamper rejections.
- **Compound fault on D1:** PASS with 12/12. The price move raises the control's step 2 to 51.43 USDC.
- **Five cohorts in parallel:** `bench wsb-acc2 complete: 5 cohorts audited and tamper-tested, new spend $0.00000000`.
- **Regression, default ports:**
  - default four: outcomes identical to the chain-faults report; PASS with 10/10 (the 9 old cases + a fault-parameter case);
  - distinguishing states (plan_guard): PASS with 10/10.

## Changes
- **`run-v2.ts`:**
  - `--port-base` (Anvil 18545, fork proxy 18546, LLM 18650, mock gate 18652), recorded as `manifest.portBase`;
  - child work folders include the runner's pid; busy-port guard;
  - `--lag-ms`, `--reorg-delay-ms`, `--hide-ms`;
  - `COMPOUND_FAULTS = [stale_then_price, dropped_then_reorg]`, implemented as a journal-driven getter on `fault.kind`;
  - mock quotes include the price move.
- **`fork-oracle.ts`:** `startAnvil(block, port)`.
- **`verify-v2.py`:**
  - fault checks built from components;
  - checks compound event order;
  - checks the hide and lag windows within [param, param + 15 s], and that the reorg comes at least `reorgDelayMs` after the receipt was served.
- **`test-verify-v2.py`:**
  - new cases: `fault parameter edited`, `compound events reordered`;
  - `fault event removed` now deletes every event of that kind;
  - so tamper counts rise by 1 for folders with a hidden, stale or reorg fault.
- **`scorecard.py` (new):** imports `metrics.py` in-process. Columns: correct-decision rate, unsafe episodes, median comparable IVL / BDT / PAF, completion, cost.
- **`bench.sh` (new).**

## Incident
In the first launch, the H2 lane on base 500 hit port 19045, which another workstream was using. The fork-head check stopped it before any write ("Fork head 26250603 is not the pinned block 26250601"). The busy-port guard now catches this up front, and acceptance was re-run as `wsb-acc2`.

## Deviations and proposed patches (outside WS-B's ownership; the coordinator applies them)
1. **Fault parameters:** `fork-rpc-proxy.ts` `reset()` takes `FaultParams {lagMs, reorgDelayMs, hideMs}` instead of constants. run-v2 passes them and drops the refusal. The control's reorg wait becomes `spec.reorgDelayMs + 5000`.
2. **`dropped_then_reorg` control:** apply the reorg wait to both `sale_reorged` and `dropped_then_reorg`, and use a separate `resentAfterReorg` flag, so the control can re-send once for the drop and once for the reorg.
3. **Fragile compounds:** the getter-based compounds depend on the order of the proxy's sale-mined branches. Native compound kinds would be more robust; the order checks would catch a break.
4. **Rule breach (minor):** while testing `bench.sh`'s refusals, it was invoked once with `BENCH_ALLOW_LIVE=1 --mode=live` and no budget. It refused at the budget check before reading any key or making any network call.

## Open problems
- **`metrics.py` sale_dropped bug:** already fixed on `research/evidence-layer` (`503d90ffe9`).
- **Compound scenarios:** no fault time or BDT is defined for them in `metrics.py` yet.
- **Mixed-task IVL:** the scorecard median pools tasks with different X; use `--by-task`.
- **Must fix before live runs:** in `rpc_stale` and `sale_reorged`, a live agent that never sells fails the audit instead of being scored.


## Independent analysis recovery (Codex, 14 November 2026)

On isolated branch `research/scorecard-recovery-1114`, fixes `57409afc8a` and
`9080fe3e1f` correct two analysis bugs without changing running cohort source.
Mixed evidence/no-layer scorecards previously raised TypeError because boolean
and string arm keys were sorted together. Ablations were also pooled into the
full-layer group. String arm labels and explicit metadata now retain five
separate groups. JSON, Markdown and --by-task all passed; real input audits
passed. Synthetic copies test grouping only, not ablation performance.

The metrics Markdown median previously selected the upper middle value for
even samples. It now uses statistics.median; even, odd and empty cases passed.
The actual pilot per-episode JSON output is byte-for-byte unchanged. No raw
result or historical report was overwritten.

Detailed local artifacts: `test-results/scorecard-recovery-1114/`. A separate
main-study readiness memo and planning-only budget are in
`test-results/main-study-readiness-1114/`. They identify missing baseline/fault
implementations, held-out exposure wording, clock/confirmation comparability,
gas and expected-loss caveats, and bounds on offline counterfactual replay.
No draft/preregistration was rewritten and no new spend was approved or used.

Authored-by: Codex (OpenAI).
