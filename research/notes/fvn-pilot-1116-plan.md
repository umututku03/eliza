# Live mini-pilot: full evidence layer vs nonce pinning only (pre-registration, 16 Nov 2026)

**Approval.** The user, on 16 Nov 2026: "okay then ifs cheap, why not run it and then update the draft with that too", after a proposal of about $2–3. The coordinator set a hard cap of **$3.00 new spend** ($1.50 per lane). Prior cumulative ledger: **$14.12007755** (after small-pilot-1115).

**Question.** Does a live model act better on the layer's graded evidence than on nonce pinning's plain success/failure wording? This answers the review question "why not just pin the nonce?". Duplicates are 0 in both arms by construction (pinned nonce), so they are not an outcome.

**Design.** ElizaOS, luna, task D1 (development task), condition stock, harness commit at launch (recorded by bench.sh). Arms `full` and `nonce_only`, run concurrently in paired lanes.
- Cohort A (per arm): `normal, sale_dropped, sale_reorged` with the reorg **12 s after the receipt is seen** (delay trigger; one slot, from the fault-realism notes), r = 5.
- Cohort B (per arm): `sale_reorged` with the **next-send** trigger, r = 5.
- Options in every cohort: idle blocks every 30 s, hide/lag 60 s (unused here). **Known deviation:** mainnet slots are 12 s; 30 s keeps this pilot comparable with pilot1114 and small-pilot-1115. The main study moves to 12 s.
- 40 model episodes plus deterministic controls.

**Choice of the 12 s timing (made before any live data).** Mock check `fvn-mock-1116` at faad400bd7 (naive agent, r = 1): at 12 s, full reached the goal after the reorg and nonce_only did not. At the next-send trigger, G1 (g1r-1116) showed both stop with no false completion.

**Primary endpoint (one).** Goal reached **and** no false completion (declared COMPLETED with the goal missed), pooled over the three fault cells (dropped, 12 s reorg, next-send reorg): 15 full vs 15 nonce_only. Reported as counts with a one-sided Fisher test and Newcombe interval. With n = 15 per arm only large differences are detectable; this is a pilot.

**Predictions.**
- 12 s reorg: full ≥ nonce_only on the primary endpoint; nonce_only more often misses the goal or falsely completes.
- Next-send reorg: **no difference expected** (both stop).
- Dropped: no strong prediction (both resend on the pinned nonce).
- Normal: parity.

**Null framing (registered now).** If there is no difference, the paper's case for the layer rests on the at-most-once guarantee and on the absence of false completions, and the paper reports that grading did not improve live outcomes at these timings.

**Secondary readouts.** Per-cell counts; false completions; the wallet text the agent received after the sale and whether it resent (from `[evidence-decision]` lines for full and the LLM request records for nonce_only); cost.

**Stop rules.** A run error, an audit failure or an accepted tamper case stops the run (running cohorts finish). Budget refusals are results. No retries, replacements or prompt changes. Raw folders are archived with SHA-256 hashes; only audits and summaries are committed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
