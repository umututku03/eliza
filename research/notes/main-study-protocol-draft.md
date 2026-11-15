# Main study: protocol draft (14 November 2026, not frozen)

Status: **DRAFT.**
- **Freeze:** before any paid main-study call, after (a) the pilot result, (b) the evidence layer and baselines are merged, (c) the offline replay of pilot failures is done.
- **Then:** the frozen version replaces this file, and changes after the first paid call are dated addenda only.
- **Inputs:**
  - advisor decisions: `paper-draft/advisor-decisions-2026-11-14.md`;
  - fault realism: `paper-draft/fault-realism-2026-11-14.md`;
  - ICBC checklist: `paper-draft/icbc-reviewer-checklist.md`.

## 1. Design / held-out split (the answer to "circular")
| | Design set: used to build and tune the evidence layer | **Held-out set:** never used before the frozen run |
|---|---|---|
| Tasks | D1 | **H1** (DAI → USDC, the reverse direction), **H2**, **H3** (block 26,100,000) |
| Faults | receipt_hidden, sale_dropped, rpc_stale, sale_reorged at default parameters | **compound faults** (stale_then_price, dropped_then_reorg), **sale_reorged_reincluded**, **parameter sweeps** (below) |
| Agents | ElizaOS, agent2 | the same, plus a production harness (Codex CLI) if it passes feasibility and the pilot says scale up |

**Rules:**
- Constants of the evidence layer (K confirmations, wait t, stale threshold T, check budget N) are fixed on the design set and frozen before any held-out run.
- Headline results are reported on the **held-out set**; design-set results appear separately.

## 2. Arms (at most 5 in the main table; the rest in the appendix, per the advisor)
1. **No defence** (stock wallet).
2. **Prompt only:** the system prompt tells the agent to verify before retrying.
3. **Nonce pin only:** same-nonce re-send, like a wallet's speed-up or cancel. Answers "isn't it just nonce management?"
4. **Verify-before-retry, binary** (Verified Tool Calls-style).
5. **Evidence layer, full.**

**Appendix:**
- PACE-style (stateless per-intent verifier with simulation);
- CheckpointAgent-style;
- MetaMask built-ins;
- the layer ablations (no grading, no refusal decoding).

## 3. Faults and parameters (from the realism data)
- **sale_reorged:** delay 12 s and 24 s (one and two slots), trigger `next-send`. Also run `sale_reorged_reincluded`, where the orphaned sale is re-mined.
- **rpc_stale:** lag 12, 60, 200 s (200 s is called incident-grade).
- **receipt_hidden:** 12, 60, 200 s, framed as a **bounded stress test** (no measured rate).
- **sale_dropped:** never mined; the agent's watch window is about 25 blocks.
- **normal:** in every cohort, as the paired no-fault baseline.

## 4. Models and repetitions
- **Free or cheap:** luna, haiku, and one open-weight model on the Anyscale credits; **r = 5**.
- **Flagship (needs reimbursement):** Sonnet and one GPT-6 flagship (sol); Opus if funded. **r = 3**, design-reduced: held-out tasks × the 4 core faults × arms 1, 3 and 5.

## 5. Readouts (fixed)
**Per episode:**
- unsafe effects;
- goal reached;
- declared word;
- **evidence attribution** (truthful / false failure / stale success / pending);
- BDT (consistent / wrong / censored, with censored-by-limit separate);
- PAF;
- conditional IVL;
- **fault fired**;
- cost.

**Per cell:** counts and medians with IQR.

**Harm table:** (a) **harm given the fault** (headline); (b) **expected harm** = natural rate × conditional harm, only for reorgs (0.059–0.27% per block). **Overhead of the layer:** latency per action (ms), extra RPC calls, **false-hold rate** on `normal`, gas (0: the layer runs off chain).

## 6. Budget sketch (to finalise after the pilot; prices to re-check)
- **Cheap tier:** luna + haiku, 4 tasks × (4 core + 3 held-out fault variants) × 5 arms × r = 5. **Too large serially;** reduce to the held-out tasks × core faults × arms 1, 3, 5 for the headline, and the full arms on D1. Estimate after the pilot gives real per-episode costs (≈ $0.03–0.09 per episode measured so far).
- **Flagship tier:** about 50 episodes per model × $1.2–3.5. Request ≈ $150–250 from the professor, sized exactly once the pilot data is in.

## 7. Stop rules and integrity
These are as in the pilot:
- run error, audit failure, or any accepted tamper case stops the run;
- budget refusals are results;
- no retries or prompt changes;
- the raw runs are archived with SHA-256 hashes.
