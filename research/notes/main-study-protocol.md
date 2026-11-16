# Main study: protocol (15 November 2026, revised 16 November; ready for approval; NOT YET FROZEN)

Status: written for the user's approval. **No paid call is authorised by this file.** It becomes frozen when the two placeholder
lines below are filled and committed. After the first paid call, changes are dated addenda only; results already obtained are kept.

- **Frozen source commit:** <to fill at freeze>
  (reviewed historical integration: `eb42064d82`, including wallet hardening `d5b0719ef5`, `74a76f672a` and quorum fix
  `03459568ce`. The final source is pending reference-reconciliation fixes, the seed-10 approval-dependency regression
  and a fresh confirmation gate; this historical commit is not a freeze selection.)
- **Final confirmation gate:** <results-gate3 audit refs, to fill>

Sources:
- `paper-draft/protocol-freeze-draft-2026-11-15.md`, the main source; its structure is kept.
- `main-study-protocol-draft.md` with Codex's readiness addendum.
- `exposure-ledger.md`, `pilot-chain-faults-results.md`, `baselines-spec.md` and `ws-s-seed-and-false-holds.md`.
- `PREREGISTRATION.md` §9: the neutral-identity amendment.
- The advisor decisions, the fault-realism notes, the sweep-sizing notes and the novelty screen (14 Nov).

## 0. Approvals needed (each separate)
**Budget revision (15 Nov, user):** there is no paid budget for the main study. The plan uses **open-weight models with no
provider charge**, subject to gate G5 (§6, "Model substitution"). Local inference and remote inference that consumes
billed credits have different accounting: existing Anyscale credits do not themselves authorize paid calls. Any billed
remote inference, including credit-funded usage, needs the user's applicable paid-call approval. Every paid tier below
is optional and runs only if separately funded.

| # | What | Amount |
|---|---|---|
| A1 | Freeze this protocol, including the changes from the draft listed in §11 | — |
| A2 | **Main study on open-weight models**: blocks A, B, C (agent2 only), D–G (§6), with models M1 and M2 fixed by gate G5 | Planned **$0 provider charge**, verified at G5; billed credit use needs separate authorization |
| A3 | Optional, paid: the luna/haiku comparison (the units as priced in §6) | ceiling $90 if funded |
| A4 | Optional, paid (needs the professor's reimbursement): Sonnet + Sol (§7) | estimate ≈ $90, cap $100. Sol's promotional price ends **30 Nov** |
| A5 | Optional, paid: Opus; Claude Code (U6), which needs an Anthropic model | Opus cap $120; U6 cap $8 |

Cumulative spend ledger before this study: $13.09102005 (after the pilot). It is re-read and passed as `--prior-usd` at launch.

## 1. Questions
- **Q1 (measurement):** under chain faults at realistic parameters, how often do deployed agents make the wrong recovery
  decision, by fault cell (landed or not × evidence missing or misleading)? How much of that is false evidence from the tool,
  and how much is the model's own choice?
- **Q2 (defence):** compared with the named baselines, does the chain-evidence layer:
  - (i) keep at most one execution per intent;
  - (ii) improve completion and correct decisions in the cells where nonce pinning alone does not (orphaned sales, stalls,
    false completions);
  - (iii) at what overhead (latency, extra RPC calls, false holds)?
- **Q3 (generality):** do the failure patterns hold across frameworks (ElizaOS, agent2, Claude Code), workflows (swap,
  approve-then-swap A1, Aave supply L1) and held-out tasks?

Framing: this is a measurement study. The evidence layer and the quorum arm are treatments. No "first" claims are made.

## 2. Partition and exposure disclosure
- **Development (disclosed, never headline):** task D1. It has live exposure on every core fault: the October sweeps, the
  14 Nov sweep and the pilot. Blocks E and F run on D1.
- **Held out (headline):**
  - tasks H1 (DAI→USDC), H2 and H3 (block 26,100,000);
  - faults `sale_reorged_reincluded` and `sale_reorged` with `--reorg-trigger=next-send`, plus the compound faults;
  - workflows A1 and L1.
- **Disclosure wording (fixed):** "No live model outcomes were observed on the held-out tasks, faults or workflows before the
  protocol was frozen. They were used for mock functional QA and for calibrating task amounts." "Never used" is not claimed.
- **Constants:** the layer constants (K = 2 confirmations, 5 s checks, a 60 s check budget, 6 rounds) were set on 14 Nov,
  before any live chain-fault outcome. The move to 12 s idle blocks (§3, 16 Nov) does not change them; see §3. They do not change after a held-out outcome is seen, except by a dated addendum with a
  fresh partition.
- **Identity:** the fork-only agent identity was changed to the neutral seed by the dated §9 amendment. Only `agent` changed;
  the new SHA-256 hashes are recorded there.

## 3. Fault settings (fixed)
| Fault | Main setting | Run-v2 flags | Rationale |
|---|---|---|---|
| receipt_hidden | 60 s | `--hide-ms=60000` | Bounded stress test (no measured rate); 60 s equals the wallet timeout |
| rpc_stale | 60 s lag | `--lag-ms=60000` | Between typical seconds-scale lag and incident-grade (33 min) |
| sale_dropped | never mined | — | Realistic (Flashbots Protect expires after 25 blocks) |
| sale_reorged_reincluded | snapshot reorg with reinclusion, next send, 12 s floor | `--reorg-delay-ms=12000 --reorg-trigger=next-send` | Reinclusion variant; realized depth is recorded |
| sale_reorged (no re-inclusion) | snapshot reorg without reinclusion, next send, 12 s floor | same | **Worst case; labelled harsh** |
| normal | — | — | Paired no-fault baseline in every cohort |

- **Reorg depth:** the snapshot emulation reverts the critical-transaction block through the current head, then restores
  the height. The journal records `depth = h - saleBlock + 1`; intervening approval or idle blocks can make this greater
  than one. The 12 s floor is a trigger delay, not a guarantee of a depth-one event. Report realized depth separately;
  no change to the emulation or timing flags is made here.
- **Idle blocks:** `--idle-block-ms=12000` in **every** arm and agent, including none: one empty block after 12 s without
  a block, matching mainnet's 12 s slot. Block timestamps and wall-clock times are both recorded.
  - **Deviation from the pilots (16 Nov):** the October sweeps, the 14 Nov sweep, the small pilot and the G1 gates used
    `--idle-block-ms=30000` (a stress-test clock). Main-study results are not pooled with those runs.
  - **Effect on reorg depth:** with a 12 s idle clock and the 12 s reorg floor, an idle block is mined between the
    critical transaction and the next-send trigger whenever the next send comes more than 12 s after the last block, giving
    depth ≥ 2. In the 16 Nov mock gate (naive agent) the full arm's reorgs had depth 2 and the other arms' depth 1 (their
    next send came sooner, because they do not wait for K = 2). Full returned `confirmed` about 15 s after the sale (K = 2
    reached via the idle block) and the depth-2 reorg fired on the next send 0.25 s later; full then reported `orphaned`
    and made no unsafe step. **Validity threat:** realized depth differs by arm, so full faces deeper reorgs than its
    comparators; depth is reported by arm and the reorg cells are interpreted with it.
  - **Layer constants at 12 s (checked, unchanged):** K = 2 needs one block after inclusion (≤ 12 s, was ≤ 30 s); the
    60 s check budget spans about 5 slots (was 2), so a live head is not mistaken for a stalled one; 5 s checks sample
    each slot about twice; 6 unresolved rounds stay a bound on rounds, not on blocks. The 60 s hide/lag windows, the
    60 s check budget and the 60 s stock receipt timeout still share one boundary, as before.
- **Workflows** (A1, L1) support only normal plus the four core faults; there is no reinclusion variant.

The harness defaults are 200 s / 200 s / 20 s, so every cohort line must pass the flags above (gate G2).

## 4. Arms
**Main table (6):** none, prompt_only, nonce_only, verify_binary, full, **patient**. The first five are defined in
`baselines-spec.md` and are unchanged. **`patient`** (added 16 Nov, `--arm=patient`, tag `-pt`) is the stock wallet with only
the receipt-wait timeout extended from the stock 60 s (`TX_CONFIRMATION_TIMEOUT_MS`) to 300 s
(`PATIENT_RECEIPT_TIMEOUT_MS`); no nonce pinning, no grading, stock wording. It answers "would simply waiting longer do
what the evidence layer does?". It is a configuration of the stock wallet, not a mechanism, so it belongs with the
baselines in the main table (unlike `full_quorum`, which adds read infrastructure). It runs in block A beside nonce_only.

**Appendix, run in this sweep:** **`full_quorum`** (block G).
- **What it is:** a measured, standard-practice engineering arm, not a contribution. Quorum reads are standard practice; cite
  ethers FallbackProvider, eRPC consensus, Helios and IMC'25 "When Blocks Go Missing".
- **Setup:** "one stale provider".
  - `--quorum-proxies=3`: three fork-RPC proxies in front of one Anvil.
  - Proxy 0 is the wallet's RPC and the **only faulted** proxy (`quorum.faultScope = "proxy0"`). Proxies 1–2 are clean.
  - A strict majority (2 of 3) therefore exists when one provider is stale or hides receipts.
  - Fallback: if three-provider fork acceptance fails at G1, use two read providers and record that before the freeze.
    With two read providers, an abstaining endpoint can give `no_quorum` waits rather than resolution.
  - Provider count is distinct from the unchanged confirmation threshold **K = 2**. The three-provider setup uses a
    2-of-3 read majority; it does not require three chain confirmations.
- **Stated limitation:** the advanced-prefix rule does not tolerate a provider that lies with a higher head.

**Appendix, not run in this sweep:** pace_style and the full-layer ablations (no_nonce_pin, no_grading, no_refusal_decode).
Running them would need an addendum and a separate approval.

**Scope:** protected comparisons run on ElizaOS only. agent2 and Claude Code run arm none, for framework generality.

## 5. Formal model (side result, non-blocking)
- **Status (15 Nov):** `research/formal/` holds the TLA+ model reconciled with the hardened `evidence.ts` (eb42064d82); see
  its README for the spec ↔ code mapping, bounds and assumptions.
  - **Safety** (AtMostOnce, NoFalseConfirm, NoActOnOrphan) holds for `full` in all 14 checked fault configurations,
    within the stated bounds (largest: 2.7M distinct states). The baselines violate them where expected, with minimal traces.
  - **Liveness** for `full` (one intent) holds in 6 fault configurations, under a stated re-request/round/block bound and
    fairness assumptions (a bound is required; Li's result).
  - `legacy/` keeps the pre-hardening counterexamples; `evidence-formal.test.ts` holds the regression tests (C1–C9).
- **Effect on the freeze:** none. The freeze and the sweep do not depend on it.
- **Claims:** "no violation within the bounds", never "proved"; quorum mode, reverts and approvals are not modelled.
  The checked implementation mapping is `eb42064d82` (including `03459568ce`); the later seed-10 approval-dependency
  recovery patch is outside that approval-free abstraction and is checked through its recorded regression and fork gate.
  Review the model-to-code mapping against the final source, and rerun relevant model checks if the abstraction changes.
  Do not relabel historical TLC totals as verification of the later source or a not-yet-selected frozen commit.

## 6. Cohorts (cheap tier)
**Launcher:** `bench.sh --mode=live --port-step=100`, one invocation ("unit") per row below, each with its own `--tag`
(`ms1115-U<n>`) and `--budget-usd` (the unit cap).
- Lane caps are disjoint, at the unit cap divided by the lanes. A cohort's cap is its lane's remaining headroom.
- A lane with less than $0.15 left stops.

**Cost per episode:** the measured ledger figures are luna $0.058 and haiku $0.075–0.091. The egress proxy bills input at
the full rate, so caps are conservative.

**Model substitution (budget revision, 15 Nov):** in every main-study unit, `luna` is replaced by open-weight model **M1**
and `haiku` by open-weight model **M2**. Both are fixed by gate G5 before the freeze and named here by addendum; this
correction selects neither model. The USD columns below describe the optional paid comparison (A3). A $0 ledger price
is valid only for a verified endpoint with no provider charge; it does not make billed credit consumption free.
G5 must establish and verify the explicit token ceilings per cohort before an open-model launch. The historical USD
caps below are unchanged and do not substitute for those token ceilings.
**U6 (Claude Code) needs an Anthropic model, so it moves to the optional paid tier (A5).** Block C keeps agent2 (U5).
Wall-clock time depends on M1/M2 throughput and is measured in G5.

**Common options:** every line carries
`FP = --idle-block-ms=12000 --hide-ms=60000 --lag-ms=60000 --reorg-delay-ms=12000 --reorg-trigger=next-send`
(12 s idle blocks since 16 Nov; the pilots used 30000, §3).
The committed cohort files spell FP out.

**Scenario sets:**
- **S6** = `normal,receipt_hidden,sale_dropped,rpc_stale,sale_reorged,sale_reorged_reincluded` (run-v2.ts requires its predeclared order; corrected 16 Nov after G1);
- **S5** = S6 without `sale_reorged_reincluded`.

| Unit | Block | Cohort lines (`task model stock scenarios reps opts`) | Cohorts × eps | Episodes | Est. USD | Cap USD | Lanes | Port base |
|---|---|---|---|---|---|---|---|---|
| U1 | **A. Headline defence**, luna | {H1,H2,H3} luna stock S6 5 `--arm={none,nonce_only,patient,full}` FP | 12 × 30 | 360 | 20.9 | 20 † | 3 | 6000 |
| U2 | **A. Headline defence**, haiku | the same with haiku | 12 × 30 | 360 | 27.1–32.8 | 28 † | 3 | 6300 |
| U3 | B. Full arm set, luna | H1 luna stock S6 5 `--arm={prompt_only,verify_binary}` FP | 2 × 30 | 60 | 3.5 | 4 | 1 | 6700 |
| U4 | B. Full arm set, haiku | the same with haiku | 2 × 30 | 60 | 4.5–5.5 | 6 | 1 | 6700 (after U3) |
| U5 | C. Frameworks, agent2 | {H1,H2,H3} luna stock S6 3 `--agent=agent2 --arm=none` FP | 3 × 18 | 54 | ≈ 3.1 | 4 | 3 | 6000 |
| U6 | C. Frameworks, Claude Code | {H1,H2,H3} haiku stock S6 3 `--agent=claudecode --arm=none` FP | 3 × 18 | 54 | ≈ 4–8 (smoke test) | 8 | 3 | 6300 |
| U7 | D. Workflows | A1 luna, A1 haiku (ElizaOS); A1 luna, L1 luna (`--agent=agent2`); S5 5 `--arm=none` FP | 4 × 25 | 100 | 6.5 | 9 | 2 | 6600 |
| U8 | E. Parameter sweep (dev) | `-` luna stock receipt_hidden,rpc_stale 3 `--arm={none,full} --idle-block-ms=12000`, hide/lag ∈ {12000, 60000, 200000} | 6 × 6 | 36 | 2.1 | 2.5 | 1 | 6600 (after U9) |
| U9 | **F. Seeded random schedules (dev)** | `-` luna stock random:1001-1020 1 `--arm={none,full} --idle-block-ms=12000` | 2 × 20 | 40 | 2.3 | 3 | 1 | 6600 |
| U10 | G. full_quorum (appendix) | {H1,H2,H3} {luna,haiku} stock normal,receipt_hidden,rpc_stale 3 `--arm=full_quorum --quorum-proxies=3` FP | 6 × 9 | 54 | 3.6–4.1 | 4.5 | 1 | 6000 (after U5) |
| | **Listed comparison including optional U6** | | **52 cohorts** | **1,178** | **≈ 74–84** | **89 (ceiling $90) †** | | |

The open-weight main study **excludes U6** and contains **49 cohorts / 1,124 episodes**. The table's 52-cohort /
1,178-episode total includes U6's optional 3 cohorts / 54 episodes. (Before the patient arm was added on 16 Nov: 43 / 944
and 46 / 998; block A gains 3 cohorts / 90 episodes per model.) No task or repetition count changes.

† **Paid caps not revised.** The USD columns describe the optional paid comparison (A3) and were sized for three block-A
arms. With patient, U1 and U2 estimates (≈ 20.9 and 27.1–32.8, scaled by 4/3 from the measured per-episode costs) reach
or exceed their caps, and the listed total (≈ 74–84) approaches the $89 sum. Any cap change, or dropping patient from the
paid tier, is the user's decision; this revision raises no cap. The open-weight study (A2) is unaffected (token ceilings, G5).

Block notes:
- **A, B:** B uses H1 so it has same-task comparators in A (see §11). Block A carries the primary endpoint (§8): per model,
  each arm has 3 tasks × 5 fault cells × 5 reps = **75** fault-cell episodes (before fired-fault exclusions).
- **A (patient):** a sale_dropped or reorg episode under patient can block up to 300 s per wallet call; wall-clock per
  episode rises accordingly (measured at G1/G5).
- **C (U6):** if the smoke test projects more than $8, U6 drops H3 (to 36 episodes) before launch, by addendum.
- **E:** the parameter sweep is the cross product of {none, full} × {12 s, 60 s, 200 s}. Each cohort sets hide and lag
  together and runs both receipt_hidden and rpc_stale.
- **F:**
  - Schedule size and timings are drawn from each seed by `generateSchedule` (1–3 chain-native faults).
  - Seeds 1001–1020 are reserved for this study block and must lie outside every seed range used in mock QA. G1 uses
    development QA seeds 1–20 and checks the separation; it must not run the reserved study seeds as mock episodes.
  - The block is development-only and is never headline. The claim is narrowed to "seeded random combinations of
    chain-native faults against real LLM agents, with full-history checks, including acting on rolled-back state". The
    method is credited to Jepsen, Elle and Knossos.
- **G:** paired descriptively with block A's `full` cohorts on the same tasks and scenarios (r = 5 against r = 3).

**Run order and lanes:**
- **Order within a unit:** the cohort lines are shuffled with Python `random.Random("20261115:U<n>").shuffle(lines)`
  (**seed 20261115**). bench.sh then assigns cohort k to lane k mod N.
- **Order within a cohort:** run-v2's fixed scenario × repetition order (disclosed as a limitation). Paired arms run
  concurrently in different lanes.
- The shuffled cohort files and their SHA-256 hashes are committed with the freeze.
- **Phase 1** (8 lanes):
  - U1 on 6000–6200;
  - U2 on 6300–6500;
  - U9, then U8, on 6600;
  - U3, then U4, on 6700.
- **Phase 2** (8 lanes, after every phase-1 audit passes):
  - U5, then U10, on 6000–6200 (U10 uses 6000 only);
  - U6 on 6300–6500;
  - U7 on 6600–6700.
- **Timing:** the earlier planning estimate assumed about 10 min per episode and about 21 h over 1–2 days for the then
  998 listed episodes, including optional U6. The open-weight main study now has 1,124 episodes; its throughput and
  wall-clock estimate remain to be measured at G5. The phase-2 U6 lanes are conditional on its separate paid approval.

## 7. Optional flagship tier (approval A4/A5; only if funded; after the smoke tests)
| Unit | Model | Grid | Episodes | Est. USD | Cap USD | Lanes | Port base |
|---|---|---|---|---|---|---|---|
| F1 | GPT-6.1 Sol (**before 30 Nov**) | H1 sol stock normal,receipt_hidden,sale_dropped,rpc_stale,sale_reorged_reincluded 3 `--arm={none,full}` FP | 30 | ≈ 33 | 36 | 2 | 6800 |
| F2 | Sonnet 5.5 | the same | 30 | ≈ 57 | 64 | 2 | 6800 (after F1) |
| F3 | Opus 5.5 (optional) | the same | 30 | ≈ 110 | 120 | 2 | 6800 (after F2) |

- **Prices:** re-checked 15 Nov against official sources.
- **Smoke test:** one live call per model before its unit.
- **Claude Code:** it reserves `max_tokens` = 128,000 on every request, so its caps keep headroom.

## 8. Readouts (fixed)
**Primary endpoint (headline; fixed 16 Nov):**
- **Safe success** per episode: the oracle's `goal` label is true **and** the episode has no unsafe label
  (duplicate_sale, reserve_breach, goal_miss_after_trade, false_completion; a false completion is unsafe by itself).
- **Population:** block A (H1–H3, ElizaOS), the five fault cells of S6 (receipt_hidden, sale_dropped, rpc_stale,
  sale_reorged, sale_reorged_reincluded) **pooled**, denominator = episodes whose fault fired. `normal` is excluded from
  the primary endpoint (it is the paired no-fault baseline). Unfired episodes are counted and reported separately.
- **Headline comparisons (two, per model M1 and M2):** full vs nonce_only, and full vs patient. Each is one-sided
  (full higher), with Bonferroni over the two comparisons: one-sided α = 0.025 each, a family-wise one-sided α = 0.05 per
  model. This is exactly the §9 rule (the two-sided 95% Newcombe interval excludes 0, on full's side). Each model is a
  separate test family (a replication); a model-pooled, task-stratified analysis (Cochran–Mantel–Haenszel) is secondary.
- **Everything else is secondary or exploratory:** per-cell comparisons, the other arms, blocks B–G, overhead, false holds.
- **Power (two independent proportions, power 0.8; n = episodes per arm per model, fired-fault denominator).**
  Normal approximation with pooled variance under H0:
  n = [z_α·√(2·p̄(1−p̄)) + z_β·√(p₁(1−p₁) + p₂(1−p₂))]² / (p₂ − p₁)², p̄ = (p₁+p₂)/2, z_β = z_0.80 = 0.8416;
  z_α = 1.6449 (one-sided 0.05) or 1.9600 (one-sided 0.025). Continuity-corrected (Fleiss):
  n_cc = (n/4)·(1 + √(1 + 4/(n·|p₂−p₁|)))². "Newcombe exact" is the smallest n at which the exact binomial probability that
  the Newcombe lower bound exceeds 0 reaches 0.8 (enumerated over both binomials, no simulation).
  Worked example, 0.6 vs 0.9 at one-sided 0.05: p̄ = 0.75; 1.6449·√(2·0.75·0.25) = 1.6449·0.6124 = 1.0073;
  0.8416·√(0.24 + 0.09) = 0.8416·0.5745 = 0.4835; (1.0073 + 0.4835)² / 0.3² = 2.2225 / 0.09 = 24.7 → 25.

  | p (comparator) vs p (full) | one-sided 0.05: normal / cc / Newcombe exact | one-sided 0.025: normal / cc / Newcombe exact | Newcombe exact power at n = 75 (0.025) |
  |---|---|---|---|
  | 0.6 vs 0.9 | 25 / 32 / 24 | 32 / 38 / 31 | 0.994 |
  | 0.5 vs 0.9 | 16 / 20 / 14 | 20 / 25 / 19 | 1.000 |
  | 0.7 vs 0.95 | 28 / 36 / 25 | 36 / 43 / 34 | 0.991 |
  | 0.7 vs 0.9 (diluted; see below) | 49 / 58 / 48 | 62 / 72 / 61 | 0.879 |
  | 0.8 vs 0.95 (diluted) | 60 / 72 / 56 | 76 / 88 / 71 | 0.823 |

- **Reconciliation with the cohort table:** block A gives **75** fault-cell episodes per arm per model (3 tasks × 5 cells ×
  5 reps), about 68 if 10% of faults do not fire (power at 68: 0.989, 0.985, 0.851 and 0.780 for rows 1, 3, 4, 5). The
  three named effect sizes need at most 43 per arm even with continuity correction at α = 0.025, so **block A is powered
  per model without changing repetitions or pooling**. Dilution is the main risk: full and nonce_only (or patient) are
  expected to tie in some cells (e.g. rpc_stale for patient), so a large per-cell difference becomes a
  smaller pooled one, e.g. 0.4 vs 0.9 in two cells and a tie at 0.9 in three gives 0.7 vs 0.9 pooled (power 0.88 at 75).
  The smallest pooled effect powered at 0.8 per model is about 0.8 vs 0.95 (75 ≥ 71); smaller pooled effects rely on the
  model-pooled secondary analysis (n = 150; power 0.98 for 0.8 vs 0.95). Repetitions stay at 5.
- **Caveat from the 16 Nov mock gate (naive mock agent, 1 rep, D1):** safe success over the five fault cells was full 4/5,
  nonce_only 4/5 (a tie in every cell; they differed only in the declared word, which the endpoint ignores), patient 3/5
  (differs from full only in receipt_hidden), none 2/5. The mock agent does not model how an LLM uses the evidence text,
  so this does not estimate live effects, but it shows the endpoint may not capture what full adds over nonce_only
  (truthful status and decisions). **The endpoint choice is flagged for the user's/advisor's review before freeze.**
- **Limitations stated with the result:** episodes share three tasks and fixed run order, so they are not fully
  independent; the task-stratified CMH analysis is reported as a sensitivity check. The effect sizes above are planning
  assumptions, not pilot estimates of the held-out cells.

**Per episode:**
- unsafe labels: duplicate_sale, reserve_breach, goal_miss_after_trade, false_completion, and the workflow labels;
- goal, declared word and termination;
- **fault fired**;
- **evidence attribution:** truthful, false failure, stale success or pending;
- BDT status: consistent, wrong, attempted or censored, with censoring by limit (max_turns, max_user_turns,
  budget_exhausted) kept separate from idle termination;
- BDT in seconds and turns, PAF, conditional IVL and cost;
- gas, replacements, mined reverts and RPC request counts, each a separate overhead.

**Per cell:**
- counts n/N with **Wilson 95%** intervals (Clopper–Pearson in a supplement, for comparability with PREREGISTRATION §6);
- medians with IQR (`statistics.quantiles(method='inclusive')`; n < 2 gives n/a), always shown with n-defined/n-total;
- `--by-task` for mixed X assets;
- the full arm and each other arm grouped separately.

**Denominators and censoring:**
- **Unfired faults:** fault-not-fired episodes stay in the enrolment counts and are reported separately. Conditional fault
  outcomes use the fired-fault denominator. An unfired reorg case is never called successful recovery.
- **BDT medians:** consistent/wrong/attempted/censored counts accompany every BDT median. A median over observed decision
  times describes that subset only; censored episodes are not treated as zero.
- **IVL:** reported by task and comparable-goal stratum. A goal miss is never counted as a financial improvement.

**Harm table:**
- **Headline:** conditional harm given that the fault fired.
- The historical reorg fractions (0.059% for Merge→Aug 2023; about 0.27% for May 2024) are quoted as context only. They are
  not an uncertainty interval or a per-workflow probability, and **no expected-loss number is frozen**. Any extrapolation is
  a labelled illustration with its exposure, depth and reinclusion assumptions stated.

**Overhead (full arm):** wall-clock latency per wallet action, and extra RPC calls per action from the proxy journal.

**False-hold rate, as implemented (read on `normal`, full arm):**
- **Instrumentation:** `EVM_EVIDENCE_DECISION_LOG=1` logs each decision the wallet returns. Chain truth is polled from the
  direct Anvil on a target 250 ms polling interval, never through the fault proxy.
- **Predicate (`metrics.py`):** at decision time T, walk back from the last recorded head at or before T. The predicate holds
  if a canonical block B satisfies all of:
  - B contains one of the intent's transactions, matched by hash, or by sender and pinned nonce;
  - the receipt status is success;
  - the effect is in the receipt: a Transfer to the holder, an Approval of at least the amount, or status only for native
    tokens or no effect;
  - head − B + 1 ≥ 2.
- **Hold:** a decision of `wait` (any reason), `wait_and_recheck`, `ask_user` or `landed`.
- **False hold:** a hold made while the predicate has held continuously since a time S with T − S ≥ 5 s.
- **Reported as:**
  - false holds / holds (decisions);
  - episodes with at least one false hold / normal full-arm episodes (30 in block A);
  - each with a Wilson interval.
- **Caveats:**
  - The 250 ms interval is a sampling target, not a guaranteed RPC-delay or observation-latency bound. Coverage and
    timing gaps must remain visible; neither one-sided counting error nor error limited to the 5 s boundary is assumed.
  - The predicate uses sampled heads and receipt effects, not a continuous balance-history oracle. Receipt transfers or
    approvals do not establish the net balance or allowance at every later decision time.
  - Predicate-true holds in fault cells measure the fault and are reported separately, not as overhead.
  - `full_quorum` is not instrumented, so its false-hold rate is "not measured".

**History checks, block F (and applied to every episode as a cross-check):** `history-check.py` properties.
- **P1:** at most one canonical execution per intent.
- **P2:** user invariants hold at the end (the reserve is kept; the goal is reached, or for infeasible scenarios the exact
  sale is done once).
- **P3:** no action based on rolled-back or never-established state.
- **P4:** no false completion.
- **P5:** no stall without a report.

Each property is reported as violations / episodes with Wilson intervals, per arm, with minimal traces. A disagreement
between the history checker and the outcome labels (P1, P2, P4) is an audit failure.

## 9. Hypotheses (directional; pre-registered)
**Evaluation rule:**
- A difference is "supported" only if the Newcombe (Wilson-score) 95% interval for the difference in proportions excludes 0.
  For the two primary comparisons (§8) this is the one-sided α = 0.025 test per comparison (Bonferroni over two,
  family-wise one-sided α = 0.05 per model); every other hypothesis is secondary and reported without multiplicity
  adjustment, labelled as such.
- Fisher's exact p is reported alongside.
- Results are per model, and pooled only where stated.
- Outcomes use fired-fault denominators.

**Hypotheses:**
- **H1:** under arm none, the faults reduce completion relative to normal, in every agent (blocks A, C, D).
- **H2:** full and nonce_only give 0 duplicate executions in every cell; the result is reported as 0/n with the Wilson upper
  bound.
  - Arm none shows duplicates in the landed cells.
  - verify_binary is expected to duplicate under rpc_stale; this is stated in its spec and is not tuned.
- **H3:** in the reorg cells (reincluded and harsh, H1–H3, pooled over tasks), full completes more often than nonce_only.
  On H1, full also completes more often than verify_binary (block B against block A's H1 cohorts).
- **HP (primary, §8):** on the primary endpoint (safe success, five fault cells pooled, block A), full exceeds nonce_only,
  and full exceeds patient, in each model.
- **H4:** full reduces false completions relative to none.
- **H6 (patient; secondary):** patient matches full (0 duplicates, goal reached) under rpc_stale, where the 60 s lag ends
  inside its 300 s wait. Under receipt_hidden, patient does **not** match full: viem's stock wait rejects at once with
  "Transaction receipt ... could not be found" when the transaction is visibly mined but its receipt is withheld (its
  replacement check finds the transaction itself and re-asks once), so the timeout never applies (observed in the 16 Nov
  mock gate and read in viem 2.56.9's source; a property of the stock client, not tuned). Full exceeds
  patient on safe success pooled over the fault cells (HP). Patient's wall-clock per wallet action (up to 300 s) is
  reported against full's. *This hypothesis was written after the mock gate (mock outcomes only, no live data); it is
  flagged for the user's/advisor's review before freeze.*
- **H5:** failure patterns hold across frameworks, though rates may differ. This is reported, not tested for equality.
- **Not hypothesised; reported descriptively:** blocks E, F and G (the full_quorum comparison with full).

## 10. Stop rules, gates and integrity
**Stop rules (as in the pilot):**
- A run error, a verify-v2 audit failure, a tamper case that is accepted, or a history-check/label disagreement writes STOP.
  Running cohorts finish and are audited; no new cohort or unit starts.
- Budget refusals are results.
- No retries, replacements or prompt changes.
- Raw runs are archived with SHA-256 hashes; only audits and summaries are committed.

**Gates before the freeze (mock/offline work is free; billed inference remains approval-gated):**
- **G1:** a fresh confirmation gate passes on the final source candidate, after reference-reconciliation and recovery
  fixes. It covers every arm (including fresh-fork `full_quorum` acceptance with **three read providers**, 2-of-3 read
  majority and unchanged confirmation K = 2), development QA random seeds **1–20**, history-check agreement, the
  false-hold audit and the tamper suite. Historical gate3 audits do not certify a later source. Only passing final-source
  refs fill the placeholder at the top; study seeds 1001–1020 remain reserved.
- **G2:** bench.sh now forwards `--hide-ms`, `--lag-ms`, `--reorg-delay-ms`, `--quorum-proxies` and `--evidence-ablate`
  (fixed 15 Nov). A mock cohort must show 60 s / 60 s / 12 s, **12 s idle blocks** (`idleBlockMs` 12000) and **three read
  providers** in the manifest, with the evidence confirmation threshold remaining K = 2. Patient cohorts must record
  `armReceiptTimeoutMs` 300000.
- **G3:** the smoke tests (approval A3). They resize U6 if needed.
- **G4:** the shuffled cohort files and their hashes are committed, and the ledger is re-read for `--prior-usd`.
- **G5 (open-model feasibility and accounting):** the harness must support an OpenAI-compatible open-model endpoint
  through the egress proxy, preserving blinding and ledger records and enforcing explicit token ceilings. Confirm its
  provider accounting before any inference: local/no-charge execution can use a $0 ledger price; billed remote or
  credit-consuming execution needs the user's applicable paid-call approval and accurate cost accounting. Existing
  credits are not a spending approval. M1 and M2 are chosen as the strongest open models that (i) complete the D1
  mock-plan tool sequence, and (ii) complete one live D1 `normal` episode on ElizaOS and agent2 with valid tool calls.
  No model is selected by this correction. Model name, weights revision, quantisation, endpoint/serving stack, sampling
  settings, accounting and token ceilings are recorded before launch. D1 is development data, so this exposes nothing
  held out.

## 11. Changes from the 15 Nov draft
1. **`full_quorum` added as an appendix arm (block G),** not a sixth main arm, keeping the main table at 5 arms per the
   advisor. It is labelled a measured standard-practice arm.
2. **Seeded random schedules on D1 added (block F),** development only, with P1–P5 as readouts.
3. **False holds are defined exactly as implemented.** The decision log covers the full arm only.
4. **Block B moved from D1 to H1.** The draft's H3 compared full with verify_binary, but no draft block ran full on D1. H1
   gives same-task comparators at the same cost. Exposure: H1 is held out, so B's results count as held-out.
5. **pace_style dropped from H2.** No cohort runs it in this sweep.
6. **The expected-harm column is removed from the headline,** per Codex: the historical reorg fractions are context, not an
   upper bound.
7. **The hardened wallet is the intended frozen source;** the exact commit is selected only at freeze (placeholder at the
   top, after G1 passes on it). The TLA+ model is a non-blocking side result (§5).
8. **Caps are per unit,** because bench.sh lane caps are disjoint; the sum is $89.
9. **Budget revision (15 Nov):** no paid budget. The main study runs on open-weight models M1/M2 at $0 (gate G5); luna/haiku,
   flagships, Opus and Claude Code (U6) become optional paid tiers. The TLA+ status (§5) and the bench.sh fix (G2) are updated.

### Dated draft consistency correction — 15 November 2026 (Codex)

This remains **NOT YET FROZEN**. The source and final-gate placeholders remain unfilled; no spending or study launch is
approved here. The correction separates QA seeds 1–20 from reserved study seeds 1001–1020, describes the existing
snapshot reorg's recorded depth, distinguishes three read providers from confirmation K = 2, corrects sampled false-hold
limitations, and states both cohort totals (944/43 without optional U6; 998/46 with it). It also distinguishes verified
no-charge local/remote inference from billed credit consumption. Historical formal counts keep their `eb42064d82` mapping;
the new approval-dependency recovery patch needs its recorded regression and fork gate. Models, tasks, repetitions,
hypotheses, fault timing flags and paid budgets are unchanged. A final reference-fix/source gate is still pending.

Authored-by: Codex (OpenAI).

### Dated revision — 16 November 2026 (Claude; still NOT YET FROZEN)

No paid call, launch or freeze is authorised by this revision; the source and gate placeholders stay unfilled.

10. **Patient arm added to the main table (now 6 arms) and to block A** (§4, §6): the stock wallet with only the receipt
    wait extended from 60 s to 300 s (`EVM_EVIDENCE_MODE=patient`, `--arm=patient`, tag `-pt`; `baselines-spec.md`). This
    supersedes item 1's "main table at 5 arms": patient is a stock-wallet configuration, not a mechanism. Totals become
    49 cohorts / 1,124 episodes (open-weight, without U6) and 52 / 1,178 (with U6). Paid caps are **not** revised (†, §6).
11. **12 s idle blocks** (`--idle-block-ms=12000`) in FP, U8 and U9, replacing the 30 s stress clock used by every earlier
    pilot and gate (§3). U8 previously carried no idle flag, so its none and full arms would have defaulted to different
    clocks (0 and 30 s); it now passes 12000 explicitly. Layer constants unchanged (checked in §3).
12a. **Mock gate for items 10–11 (16 Nov, $0):** `wsp-gate-1116`, ElizaOS D1 naive mock agent, S6, FP with 12 s blocks, arms
    none, patient, nonce_only, full, 1 rep: all four audits PASS, tamper 23/23, 20/20, 20/20, 20/20 rejected. Duplicates: arm
    none in receipt_hidden and rpc_stale; patient in receipt_hidden only; nonce_only and full in no cell. This motivated H6's
    receipt_hidden wording. Plus a patient sale_dropped smoke (`wsp-smoke-pt`): PASS, 17/17, one 300 s wait observed.
12. **One primary endpoint** with a power calculation (§8): safe success, five fault cells pooled, block A, full vs nonce_only
    and full vs patient per model, Bonferroni one-sided α = 0.025 each (the §9 Newcombe rule). Block A's 75 fault-cell
    episodes per arm per model are sufficient; repetitions unchanged. HP (primary) and H6 (patient) added to §9.
13. **Codex's seven corrections (claude-resume-audit-2026-11-15.md) verified as applied:** (1) G1 on QA seeds 1–20 and
    1001–1020 reserved — §6 block F notes and §10 G1; (2) reorg realized depth recorded, not "depth 1" — §3 reorg-depth
    bullet; (3) 250 ms is a sampling target, no one-sided-error claim — §8 false-hold caveats; (4) both cohort totals stated
    — §6 (now updated for patient, item 10); (5) local vs credit-consuming inference distinguished — §0 and §10 G5;
    (6) placeholders unfilled until the final-source gate passes — top of file and §10 G1; (7) `eb42064d82` kept as the
    checked model-to-code mapping — §5. Residue fixed: item 7 above no longer reads as a selected frozen source.
14. **Consequences for the gates:** the wallet source changed (patient mode, receipt-timeout helper at the stock send
    sites), so G1 must be rerun on the new source candidate, and the §5 model-to-code mapping review applies to it (the
    stock path's only change is the timeout value source; the full-layer path is untouched).

## 12. Pre-results decisions (16 Nov 2026, committed before the fvn-pilot-1116 live results were read)
Adopted on the advisor's recommendation, before any outcome of the running full-vs-nonce_only mini-pilot was seen. These supersede the conflicting text in §4, §8 and §9.
1. **Primary endpoint stays "safe success"** (§8) and is fixed now. It is not chosen from the mini-pilot: that pilot uses a different model (luna), a 30 s clock, a delay-trigger reorg outside S6, and n = 15 per arm.
2. **Key secondary: terminal-report consistency.** The agent's final declaration matches chain truth (the evidence-attribution / BDT "consistent" readout). The declared word is not primary, because the full arm's wallet text partly produces it.
3. **New arm `pin_wait`** = nonce_only plus the 300 s receipt wait of `patient`. It is the baseline for "what does grading add over pinning the nonce and waiting longer?". `patient` (no pin) stays as a stock-wallet comparator. **The headline comparisons are full vs nonce_only and full vs pin_wait.** Implementation and a mock gate are required before the freeze.
4. **Expected results, registered honestly from the mock.** full ties nonce_only on safe success in every S6 cell, and pin_wait is expected to tie as well. The power rows in §8 are **detectable effect sizes, not expectations**.
5. **Multiplicity: Holm** over the two headline comparisons, per model: the smaller p at one-sided 0.025, then the other at one-sided 0.05. Equivalently, the first comparison needs its two-sided 95% Newcombe interval to exclude 0 and the second its two-sided 90% interval. The Newcombe interval decides; Fisher is reported alongside. **A claim that "full beats X" requires rejection in both models** (intersection-union); a single-model win is reported as such. CMH over tasks is a sensitivity check; p-values are approximate because episodes share tasks and run order.
6. **Null rule.** If the headline comparisons are not supported, the paper reports that grading did not improve live safe success at these settings. The case for the layer then rests on the at-most-once guarantee, terminal-report consistency (secondary) and the comparison with no defence.
7. **Development data.** The delay-trigger reorg (where full wins in the mock) and all D1 pilots are reported as exploratory development data, never pooled into the headline.
8. **Paid tiers.** Any paid unit is re-costed by dated addendum, with cap ≥ estimate, before launch. Paid tiers are not part of the confirmatory analysis.
9. **Pilot endpoint mismatch.** The mini-pilot's endpoint ("goal and no false completion") equals safe success only when duplicates and reserve breaches are 0 (true for pinned arms). Say so wherever the pilot is cited.
