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

## Readiness addendum — Codex, 14 November 2026 (not a freeze)

The original draft above is retained verbatim. This addendum corrects readiness
claims and provides an implementation checklist; it does not authorize model
spending or select a final experimental grid.

### What exists, and what must exist before preregistration

| Component | Current status | Gate before a main-study freeze |
|---|---|---|
| Stock and full evidence, ElizaOS | Implemented; recovery validation in separate source snapshots | Review completed audit/tamper outputs and record the exact integrated source commit |
| Evidence ablations | Implemented as no_nonce_pin, no_grading, no_refusal_decode | Keep their names: none is a substitute for the missing named baselines |
| Prompt-only baseline | Not implemented | Freeze exact prompt, position and tool access; hold all other settings equal; add mock and negative checks |
| Nonce-pin-only baseline | Not implemented | Specify unresolved intent identity, reservation lifetime, fee bumps and retry rules, with lost-ACK/reorg negatives; do not label no_nonce_pin as this arm |
| Binary verify-before-retry baseline | Not implemented | Specify its observable checks, confirmation threshold, inconclusive result and retry policy; implement and test it before citing a paper baseline |
| Agent2 + evidence | Unsupported and explicitly rejected | Add an adapter with equivalent safety/observation semantics, or restrict protected comparisons to ElizaOS |
| Reorg with reinclusion | Not implemented | Add a distinct fault with original/replacement provenance and canonical-chain audit negatives |
| Reorg on next send | Not implemented | Current proxy can fire on reads; implement the trigger named above or preregister the actual read-triggered design with its limitations |
| Offline pilot replay | Bounded replay implemented in replay-pilot.ts | Three recorded stale duplicate decisions and six negatives; this is conditional nonce-pinning evidence, not a live recovery/completion comparison |
| Descriptive quartiles | Implemented in scorecard.py | Inclusive interpolation, n-defined/n-total, undefined quartiles for fewer than two observations; keep censoring visible |
| Main-study protocol | Still draft | Close the gates above, choose exact cells/seeds/order, freeze analysis and source, then obtain a fresh spending cap |

The three baseline definitions are design work, not cosmetic labels. A fair
comparison needs equivalent task access, budgets and intended confirmation
policy, with explicit differences where the baseline itself requires them.
Changing these after seeing a held-out outcome requires an addendum and a new
evaluation partition. No flagship, open-weight integration or account setup is
claimed complete by the free recovery work.

### Exposure ledger and clocks

D1 and the four core faults have been used for implementation, mocks and a paid
pilot. H1/H2/H3 and compound faults have already been used for functional QA in
WS-B. Therefore the phrase “never used” in section 1 is too strong. Before a
freeze, enumerate each task/fault/parameter/checkpoint and distinguish functional
QA, policy calibration and model-outcome tuning. A cross-task evaluation may
still be useful, but its exposure must be disclosed. Existing reports are not
rewritten to relabel tested configurations as unseen.

The current layer constants are K=2 confirmations, 5 s checks, a 60 s check
budget and six unresolved check rounds. Recovery mocks use a 30 s wall-clock
idle-block producer in every arm. This is a stress-test clock, not Ethereum's
12 s slot cadence; block timestamps and wall-clock scheduling must both be
recorded. Intended K-confirmation waiting is not by itself a false hold. A
future false-hold measurement needs a recorded oracle predicate (canonical
inclusion, matching effect and K confirmations), the policy's decision at that
instant, and a declared grace/polling allowance. Missing counterfactual
observations in the pilot are indeterminate, not zero false holds.

### Analysis corrections to apply before freezing

- Report fault-not-fired episodes separately and retain them in enrollment counts.
  Conditional fault outcomes use an explicit fired-fault denominator. Do not
  call an unfired reorg case successful reorg recovery.
- BDT consistent/wrong/attempted/censored counts accompany any median. Limit
  censoring includes max_turns, max_user_turns and budget_exhausted and is
  distinguished from ordinary idle termination. A median over observed decision
  times is descriptive of that subset, not an estimate treating censoring as zero.
- Report IVL by task and comparable-goal stratum; a goal miss cannot be claimed
  a financial improvement because the agent kept funds instead of trading.
- Canonical gasUsed/gasCostWei, replacements, mined reverts and RPC request counts
  are separate overheads. Off-chain verification does not imply zero total gas
  overhead when retry behavior or fees change.
- Keep conditional harm as the headline. The draft's two historical per-block
  reorg percentages are not a current uncertainty interval or a per-workflow
  probability. An expected-loss extrapolation requires matching exposure,
  depth, inclusion and reinclusion assumptions; no such estimate is frozen here.
- Group full evidence and each ablation separately. Use --by-task for mixed X
  assets. Quartiles use statistics.quantiles(method='inclusive'); n<2 gives n/a.

### Planning arithmetic, not an approved run list

A candidate ElizaOS headline grid H1/H2/H3 × (normal + four core faults) ×
(none, nonce-pin-only, full) × five repetitions × two models has 450 episodes.
A D1 five-arm supplement has 250. These are planning examples; the missing
baselines are not ready and neither grid is approved. Historical pilot means
project approximately $30.67 and $17.04 respectively ($47.70 combined), with
no allowance for changed model-call counts, prices, extra scenarios or flagships.
The final selection, justification, randomized/block order, exact budgets and
stop rules must be written before a paid main-study launch.

Primary-source checks for interpreting fault realism (checked 14 November):
- Ethereum consensus documentation describes 12 s slots, which may be empty:
  https://ethereum.org/developers/docs/consensus-mechanisms/pos/
- The historical Merge-to-August-2023 reorg analysis reports 1,410 reorgs,
  including four depth-two events and a 0.059% reorged-block fraction for that
  dataset: https://ethresear.ch/t/the-second-slot-itch-statistical-analysis-of-reorgs/16333
- The May-2024 four-week analysis reports 487 reorgs in roughly 184,000 slots
  (about 0.27%); its period and denominator differ:
  https://ethresear.ch/t/big-blocks-blobs-and-reorgs/19674
- Geth's documented 3 h txpool lifetime applies to queued, non-executable
  transactions, not every pending transaction or a measured drop frequency:
  https://geth.ethereum.org/docs/fundamentals/command-line-options

These sources motivate scoped scenarios; they do not establish the incidence
of our synthetic receipt-hiding/stale-RPC stress tests or novel scientific claims.

Authored-by: Codex (OpenAI).
