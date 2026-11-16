# Live mini-pilot: full evidence layer vs nonce pinning only (results, 16 Nov 2026)

Pre-registered in `fvn-pilot-1116-plan.md` (commit 2d7f96c389). The protocol's pre-results decisions (commit 47d832197c, 08:50 EST) were committed before any result was read. ElizaOS, luna, task D1, condition stock, idle blocks every 30 s.

## Runs and integrity
| Tag | Cohorts | Harness | Audit |
|---|---|---|---|
| `fvn-pilot-1116` | 0: full, A (normal, sale_dropped, sale_reorged at 12 s); 1: nonce_only, A | 2d7f96c389 | **PASS** for both (tamper 21/21 and 17/17 rejected), after verifier fix 597396245b. The bench STOP on cohort 1 was a verifier gap: an approval sent after a dropped sale stayed pooled behind the missing nonce. |
| `fvn-pilot-1116b` | 0: full, B (sale_reorged at next send); 1: nonce_only, B | 597396245b | **FAIL** for both: "agent_idle termination after an acting turn". In one episode per arm (`luna-v2-ev-r3`, `luna-v2-no-r2`), ElizaOS's reply generation errored in a turn that had sent the approval (the send that fired the reorg). The harness then labelled the episode `agent_idle`. The verifier is right; the harness mislabels termination after an errored turn that sent a transaction. **These cohorts are reported as unaudited.** The harness fix is listed for the main study. |

The B cohorts were started under a new tag after the STOP left them unstarted. Their lines are identical to the pre-registered file (`cohorts-fvn-pilot-1116b.txt`).

- New spend: $2.38057887 ($1.02522262 + $0.80547912 + $0.29671275 + $0.25316438), within the $3.00 cap.
- Cumulative ledger: **$16.50065642**.
- Raw folders (with the fvn mock check) are archived in `eliza-v2-run-archive/fvn-pilot1116/` (4,516 files), with SHA-256 hashes appended to `SHA256SUMS`.

## Outcomes (n = 5 per cell). Safe success = goal reached, no unsafe label, no false completion
| Cell | full | nonce_only |
|---|---|---|
| normal | 4/5 | 5/5 |
| sale_dropped | **4/5** | **1/5** |
| sale_reorged, 12 s after the receipt | **5/5** | **0/5** |
| sale_reorged, at next send (unaudited) | 1/5 | 0/5 |

There were no duplicates in either arm (both pin the nonce) and no false completions.

**What the layer returned (full arm, `[evidence-decision]` lines):**
- After a drop, the first decision was `resend_same_nonce` in 5/5 episodes.
- After the 12 s reorg, the first decision was `orphaned` in 5/5, followed by a successful resend.
- nonce_only reported the stock outcome (success from the receipt before the orphaning).

## Pre-registered primary endpoint
Goal reached with no false completion, pooled over the three fault cells:
- **Pre-registered pooled (includes the unaudited next-send cells):** full **10/15** vs nonce_only **1/15**. One-sided Fisher p = 0.00085. Wilson 95%: [0.42, 0.85] vs [0.01, 0.30].
- **Audited cells only (dropped and 12 s reorg):** full **9/10** vs nonce_only **1/10**. One-sided Fisher p = 0.00055. Wilson 95%: [0.60, 0.98] vs [0.02, 0.40].

## Predictions
- **12 s reorg:** full ≥ nonce_only. **Held** (5/5 vs 0/5).
- **Next-send reorg:** no difference expected. **Consistent** (1/5 vs 0/5, unaudited).
- **Dropped:** no prediction registered. Full 4/5 vs nonce_only 1/5.
- **Normal:** parity. 4/5 vs 5/5. The single full miss was the agent's own step-2 choice.

## How to read this
- These are development data: one task (D1), one inexpensive model, a 30 s block clock. The 12 s delay trigger is not the main study's headline cell (protocol §12.7), so it is never pooled into the main study's headline.
- It is the first live evidence that grading adds value beyond pinning: the agent recovers when told what happened (absent, so resend; orphaned, so resend), and does not when given the stock wording.
- The main-study endpoint "safe success" equals this pilot's endpoint because duplicates and reserve breaches are 0 in both pinned arms (protocol §12.9).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
