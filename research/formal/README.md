# Bounded TLA+ model of the evidence layer (WS-T)

`EvidenceLayer.tla` models the recovery protocol of `plugins/plugin-wallet/src/chains/evm/evidence.ts` and three
baseline send policies, checked with TLC on small bounds. The top-level model follows the **hardened** wallet
(Codex commits d5b0719ef5, 74a76f672a; `evidence.ts` at `origin/research/evidence-layer` eb42064d82, quorum mode
excluded), updated on 16 November 2026 for e1c82ae7a3 (see "Re-check against the final source" below). `legacy/` keeps the model of the pre-hardening wallet (fc7ce03a5b) and the counterexamples it produced.

These are bounded results: "holds" means no violation in the finite state space of the stated bounds, not a proof.

## Running

```
./run.sh MC_full_hidden.cfg ...      # one result line per property; logs/ (ignored) and traces/
python3 -I gen_cfgs.py               # regenerates every MC_*.cfg from the bounds in gen_cfgs.py
python3 -I trace_summary.py <log>    # one line per state of a TLC counterexample
```

Tools live under `$HOME/tools/tla`; the system Java was not changed. The original WS-T installation notes record
an Adoptium Temurin 21.0.13+9 macOS aarch64 download with SHA-256
`bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a`, checked against its published checksum.
The saved completed TLC logs themselves report **Eclipse Adoptium 21.0.13 x86_64**. The locally installed Java binary
is now arm64; that later installation does not change the architecture recorded for those runs.

The jar came from the tlaplus/tlaplus **distribution release v1.7.4**. Its checker banner is **TLC2 Version 2.19,
8 August 2024, revision 5a47802**; these are different version labels for the same local artifact. Its SHA-256 is
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. The original installation report records the
published SHA-1 comparison (`bee4a54f3ee3d4afc347c3240ec2d9e93b075104`); the continuation audit verified the local
SHA-256, without repeating that historical download verification.

The saved safety runs use 8 to 10 workers; liveness runs use one worker.

## Model

- **Chain.** One sender. A sequence of block ids (block id = block hash), at most one transaction per block, nonces
  consumed in order. A mempool keyed by nonce: a bumped same-nonce send replaces the pooled tx, an unbumped one is
  "underpriced", and a nonce below the head is "nonce too low". Empty blocks come from the idle producer.
- **Faults (each bounded).**
  - `Hide`/`Unhide`: receipt_hidden. A receipt is hidden and later shown again.
  - `Drop`: sale_dropped. A pooled tx disappears.
  - Lost acknowledgement: an accepted send is reported to the wallet as an RPC error.
  - The RPC `view`: rpc_stale. A past canonical prefix, possibly from before a reorg, at most `MaxLag` blocks behind.
  - `Reorg`: the last d ≤ `MaxDepth` blocks are replaced by d empty blocks (the harness's emulated reorg). Orphaned
    txs return to the mempool when `Reinclude` is set (sale_reorged_reincluded).
- **Agent.** A naive re-sender. It repeats an intent until it is told success. The default agent is *sequential*:
  it may move on to the next intent but never returns to an earlier one. The `*_any` configs use an
  *interleaving* agent that may come back to an earlier intent. It may also call `tx_status`. With
  `AgentStopsOnAsk` (liveness configs), it stops after `ask_user`.
- **Policies** (`Policy`):
  - `full`: the evidence layer.
  - `nonce_only`: `sendNonceOnly`.
  - `verify_binary`: `sendVerifyBinary`.
  - `none`: the stock send, where viem fills the nonce from the wallet's RPC, followed by the stock receipt wait.

### Mapping (spec ↔ evidence.ts at eb42064d82, updated for e1c82ae7a3)

| Spec | evidence.ts | Simplification |
|---|---|---|
| `Observe`, `WithObs` | `observe()` | One observation reads one consistent view atomically (the code's reads are separate RPC calls). Reverts are not modelled. `canonical` holds iff the best hash is mined in the view. |
| `Observe.rs` | `receiptSeen` update: canonical inclusion by receipt *or* tx lookup; kept while an orphan is below K on its new branch | — |
| `WithObs` landed/rep reset | `orphanEvidence ⇒ landed=false, reportedOutcomes.delete` | — |
| `Decide` | `decide()` | `wait` reasons are merged, except `wait_stale`. |
| `IsUnresolved` | `isUnresolved()` (now includes `dropped`) | — |
| `CloseRound`, `Terminal` | `closeRound()`, `TERMINAL` | `N` = 3 (code: 6). |
| `CheckOnce` | `checkOnce()` (confirmed changes only on orphan evidence; a counted round adds the record to `reportedOutcomes`) | — |
| `GuardFull`, `GuardFold` | `guard()`: re-check the latest same-key confirmed record, skip records above a lower-nonce retry, re-check unresolved/confirmed/included records, refuse on the first unresolved | — |
| `FindOpenFull` | `findOpenIntent()` (a confirmed record stays open until its outcome was reported: `rep`) | — |
| `FullFirstSend` | `sendWithEvidence` first send: pin `pending` nonce, snapshot, reserve, send; any error ⇒ `pending`, EVIDENCE_PENDING | The prepare/snapshot/send sequence is atomic. |
| `FullResend` | re-send with the pinned nonce and +12.5% fees; `classifySendError` (too low ⇒ landed, underpriced ⇒ pending, other ⇒ rethrow) | `Own()`: any pooled tx of the same intent at the pinned nonce is out-bid. |
| `Poll` (`late`, `mid`) | check loop, polled every t until terminal or T; then (e1c82ae7a3) `guard(…, afterDispatch)` when the last observation has no block and `nonceLatest < pinnedNonce` | Time is abstract: `sendOld` means ≥ T since the last send, `hsOld` means head unchanged for ≥ T. `TimePasses` covers agent time between calls. |
| `TxStatus`, `LatestIntent` | `tx_status` → `checkOnce(latestIntent(), counted)`; `latestIntent` puts the lowest-nonce orphaned record first (e1c82ae7a3) | — |
| `NORequest`, `WaitDone`/`WaitTimeout` | `sendNonceOnly`, `stockWait` | The wait watches one hash (viem's replacement detection is not modelled). |
| `VBRequest`, `VBSend` | `sendVerifyBinary`, `binaryCheck` | — |
| `NoneRequest` | stock send + `waitForTransactionReceipt` | — |
| `PendingCount` | `getTransactionCount(pending)`: a fresh node counts the pool, the stale proxy answers at the lag block | — |

### Properties

- `AtMostOnce`: at most one canonical execution per intent, in every reachable state.
- `NoFalseConfirm`: confirmed or success is never reported for an intent with no execution in either the chain or
  the view that was read.
- `NoActOnOrphan`: confirmed is never reported for an intent, and no other intent is let through on top of it,
  while its only execution is orphaned and the reorg is visible in the view that was read.
- `EventuallyResolved`: every intent eventually ends confirmed, or with an explicit `ask_user` or stop.
- `EventuallyCorrect`: eventually and permanently, every intent reported confirmed has exactly one canonical
  execution.

### Liveness assumptions (bounded liveness)

Liveness is checked for `full` only (`LiveSpecFull`), with NI = 1. The assumptions:
- weak fairness on mining, view catch-up, unhiding, the wallet's own steps, the passage of agent time, and agent
  re-requests;
- every fault is bounded (one per run, no fairness), so faults stop;
- priority mining and timely inclusion;
- the agent stops after `ask_user`.

The bound is part of the result: the agent re-requests at most `MaxReq` = 5 times. `ask_user` is forced after
`N` = 3 counted rounds unless the decision is terminal. Chains are limited to `MaxBlocks` blocks.
`FairnessFull` writes each WF as `[]<>~En ∨ []<><<A>>_vars` with an explicit enabledness predicate. TLC's
`ENABLED` ran at about 10 states/s. `EnabledMatches` checks that each predicate equals `ENABLED` on
`MC_full_enabled_check.cfg`. That check covers its 818 reachable states (one intent, bounded drops and lost
acknowledgements, no hiding, lag or reorg), not every state in the larger liveness configurations or an unbounded
equivalence proof. The predicates remain an explicit modeling assumption outside the checked instance.

## Bounds

Safety configs (`gen_cfgs.py` BASE):
- NI = 2 intents; nonces 0..2; at most 4 txs and 5 blocks (6 with a reorg);
- K = 2, N = 3; MaxReq = 3 per intent; one `tx_status`; at most 3 ledger records;
- one fault of the scenario's kind;
- reorg depth ≤ 2 (≤ 1 in the compound configs); lag ≤ 2 (≤ 1 in `stale_reorg`);
- timely inclusion: a receipt wait does not time out while its tx is includable. `slowincl` drops this
  assumption.

Liveness configs:
- NI = 1; MaxReq = 5; at most 5 txs and 6 blocks (7 with a reorg);
- faults as in safety, one per run, reorg depth 1;
- the agent stops after `ask_user`.

## Results (TLC2 2.19, distribution v1.7.4, 8–10 safety workers)

These are the results for the eb42064d82 model. The 16 November re-check below gives the counts for the updated model;
only `full / reorg` and `full / reincl` changed.

Policy × scenario. A = AtMostOnce, F = NoFalseConfirm, O = NoActOnOrphan. The last column gives the full
policy's distinct states and time; every other cell checked all three invariants. Minimal (BFS) counterexamples are in
`traces/<cfg>__<prop>.trace`.

| scenario | full | nonce_only | verify_binary | none | full: states / time |
|---|---|---|---|---|---|
| slowincl | holds | holds | violates A | violates A | 91865 / 3 s |
| hidden | holds | holds | holds | violates A | 561670 / 14 s |
| dropped | holds | holds | holds | holds | 235781 / 9 s |
| lostack | holds | holds | violates A | violates A | 252780 / 13 s |
| stale | holds | holds | holds | violates A | 306338 / 7 s |
| reorg | holds | violates O | violates A,O | violates A,O | 526792 / 10 s |
| reincl | holds | violates O | violates A,O | violates A,O | 723980 / 16 s |
| hidden_reorg | holds | violates O | violates A,O | violates A,O | 2700886 / 57 s |
| stale_reorg | holds | violates O | violates A,O | violates A,O | 1294140 / 25 s |
| dropped_shared | holds | holds | holds | holds | 235781 / 8 s |
| stale_shared | holds | holds | holds | violates A | 306338 / 7 s |
| nofault_any | holds | holds | holds | holds | 213048 / 6 s |
| hidden_any | holds | holds | holds | violates A | 1308298 / 38 s |
| dropped_shared_any | holds | holds | violates F | holds | 541580 / 22 s |

| liveness config (full, NI=1) | EventuallyResolved | EventuallyCorrect | states |
|---|---|---|---|
| live_hidden | holds | holds | 7028 |
| live_dropped | holds | holds | 3731 |
| live_lostack | holds | holds | 4767 |
| live_stale | holds | holds | 8258 |
| live_reorg | holds | holds | 12031 |
| live_reincl | holds | holds | 7859 |

`MC_full_enabled_check` (`EnabledMatches`, 818 states): the explicit enabledness predicates equal `ENABLED`.

### What the baseline counterexamples show
- **none:** duplicates with a hidden receipt, a lost acknowledgement, a stale view that outlasts the receipt wait,
  or slow inclusion. The naive re-send takes a fresh nonce. After a reorg it also lets the next intent go ahead on
  an orphaned one (O).
- **verify_binary:** the binary check prevents the duplicate when the receipt is hidden, because the balance
  effect is visible. Under `stale` the fresh nonce comes from the same stale node, so the re-send is "nonce too
  low", not a duplicate. It still duplicates on a lost acknowledgement, after slow inclusion, and after a reorg
  (an orphaned success frees the nonce; a queued tx then times out and is re-sent). With a shared token it reports
  success for an intent that did not execute (F): another intent's balance increase passes the check.
- **nonce_only:** no duplicate in any scenario. After a reorg it keeps the stock "success" and lets the next intent
  take the freed nonce (O, 6 states: send, mine, success, reorg, next intent).
- **full:** all three invariants hold in every scenario, including the interleaving agent and the shared token.

### Counterexamples of the pre-hardening wallet (`legacy/`, fc7ce03a5b)
Model checking found these on the earlier wallet. They are kept as evidence.
- `legacy/MC_full_hidden__AtMostOnce.trace`, `legacy/MC_full_hidden_any__AtMostOnce.trace` (12 states, no fault
  needed). The guard silently confirmed intent 1 while checking it before intent 2. The interleaving agent had
  not been told and re-requested intent 1, which became a new record with a fresh nonce: a second execution.
  Fixed by `reportedOutcomes` / `findOpenIntent`.
- `legacy/MC_full_hidden_reorg__NoActOnOrphan.trace` and `__NoFalseConfirm.trace` (C1, 10 states):
  1. The receipt is hidden, the re-send gets "nonce too low", and the landed path confirms on the balance effect
     after one confirmation, without anchoring `receiptSeen`.
  2. A reorg orphans the swap. The orphan rule needed `receiptSeen`, so the guard kept the intent confirmed,
     `tx_status` reported "confirmed", and the next intent took the freed nonce.

  Fixed: the anchor now comes from the tx lookup, and landed requires canonical K-confirmation.
- C2, reproduced in the unit test (`legacy` model with `MC_full_dropped_shared_any`: NoFalseConfirm violated):
  1. A dropped intent's state `dropped` did not hold the guard.
  2. A different intent crediting the same token took the pinned nonce.
  3. The first intent's re-send got "nonce too low" (landed), and the other intent's balance increase confirmed it.

  Fixed: `dropped` is unresolved, and landed requires canonical inclusion of the intent's own tx.

`plugins/plugin-wallet/src/chains/evm/__tests__/evidence-formal.test.ts` reproduces C1 and C2 with property-only
assertions. They were originally expected-failure reproductions on fc7ce03a5b; the integrated tests are now ordinary
`it` assertions, including C1–C9 recovery cases and a legitimate-repeat negative case, parameterized over `full` and
`full_quorum`. The tests must pass on the hardened implementation. Their quorum coverage is an implementation test,
not part of this single-view formal model.

## Limitations
- The bounds are small: two intents, three nonces, five to seven blocks, one fault per run. Compound faults are
  limited to hidden+reorg and stale+reorg.
- Observations are atomic. Interleavings between the separate RPC reads of one `observe()` are not modelled.
- Reverts (`failed`), approvals and plan redemptions are not modelled.
- The quorum mode (`full_quorum`, 03459568ce) is excluded.
- Time is abstract (T-elapsed booleans). The check loop's 5 s polls are "early" polls; the last one is "late".
- Fee replacement is abstracted:
  - the record's own re-sends always out-bid its pooled tx;
  - a re-send against another record's pooled tx may be accepted or underpriced;
  - viem's replacement detection in `waitForTransactionReceipt` is not modelled.
- The default agent is sequential. The interleaving agent is checked in the `*_any` configs only.
- Liveness covers the full policy, with one intent and the bound stated above.

## Provenance

Codex imported an earlier snapshot of this model on 15 November (see `legacy/`) and hardened the wallet against its counterexamples; `evidence-formal.test.ts` holds the resulting regression tests (C1–C9). The top-level model here was then reconciled with the hardened `evidence.ts` (eb42064d82) and re-checked.

### Continuation audit, 15 November 2026

The audit compared the coordinator and original WS-T model/configuration bytes and checked the saved completion logs:
all 14 full-policy safety configurations, all 12 liveness property checks across six configurations, and the 818-state
enabledness check agree with the results above. The model SHA-256 is
`49e5070a7145f1a53c4eeedc8179be904042060c2d4aaffec5d98859eda04763`. Raw logs remain in the original local
`eliza-ws-tla/research/formal/logs/` directory; they are not newly generated by this audit.

The historical `run.sh` did not record model/configuration hashes at launch. The continuation's local
`test-results/claude-resume-1115/formal-evidence-inventory.json` hashes the files available **at audit time**, including
those raw logs. It records current agreement and preserves evidence for subsequent review; it cannot establish a
retrospective cryptographic binding between a historical execution and its inputs. The model maps to wallet source
at eb42064d82; later wallet changes require a fresh mapping review before these counts are quoted for another source.

Authored-by: Codex (OpenAI).

## Re-check against the final source, 16 November 2026

Source: `evidence.ts` at faad400bd7 (branch `ws/tla2`). `git log eb42064d82..HEAD -- plugins/plugin-wallet/src/chains/evm/`
lists one commit, e1c82ae7a3 ("surface orphaned dependencies after queued approval dispatch"). It changes `evidence.ts`
(+19/−5) and adds tests C10 and two negatives to `evidence-formal.test.ts`. The other commit, 97077add94 ("reconcile a
queued swap after its approval is orphaned"), touches only `research/agent-harness-v2/` (the harness control child and
its test). It does not change wallet code.

### Mapping review

| Change (e1c82ae7a3) | Modelled? | Model update |
|---|---|---|
| `sendWithEvidence`: after the check loop, if the last observation has `receiptBlock = txBlock = null` and `nonceLatest < pinnedNonce`, call `guard(…, afterDispatch = true)`. A refusal throws EVIDENCE_UNRESOLVED **before** `closeRound` (no ask_user, not added to `reportedOutcomes`). Otherwise the guard's re-checks of other records persist and the round closes as before. | yes (send path, guard) | yes: `Poll` runs `GuardFull` with the same view when the round ends and `o.incl = 0 ∧ o.nonceLatest < r.pinned`. Refused: keep the guard's ledger, `pc` idle, no `CloseRound`, no report. Not refused: keep the guard's ledger, then close and report. |
| `latestIntent`: the orphaned record with the lowest pinned nonce first (stable sort), else the latest unresolved, else the latest | yes (`tx_status`) | yes: `LatestIntent` |
| `guard(…, afterDispatch)` message wording | no (wording only) | no |
| `evidenceMessage` `wait_and_recheck`: new wording for a pending tx whose nonce is not yet used | no (wording only; `decide()` unchanged) | no |

The fix is generic `sendWithEvidence`/`latestIntent` logic, so it is modelled. What stays outside the model is the
approval-specific part:
- allowance effects and the C10 fixture (a queued approval behind an orphaned sale);
- the harness reconciliation of 97077add94;
- quorum mode.

In the model, the approval is just a second intent. `observe`, `decide`, `findOpenIntent`, nonce reservation, re-send
and orphan rules did not change. Invariants, ghosts, fairness, `EnPoll` and every `MC_*.cfg` are unchanged:
`gen_cfgs.py` regenerates them byte-identically.

Model SHA-256 before: `49e5070a7145f1a53c4eeedc8179be904042060c2d4aaffec5d98859eda04763`. After:
`d36725cf2d168ce5ecec1d7fe70784281742782c2770ecf068bbee6ae2226a34`.

### Runs

`run.sh` now takes `TLC_OUT`/`TLC_RESULTS`, so this run did not touch the saved `logs/`, `traces/` or `results.txt`.

Output is in `runs/2026-11-16/`:
- `results-2026-11-16.txt`: one line per property;
- `traces/`: the condensed counterexamples and witnesses;
- `logs/`: raw TLC logs, git-ignored because they contain local paths.

The run used TLC2 2.19 (rev 5a47802) on Temurin 21.0.13, with 10 safety workers and 1 liveness worker, and took 578 s in
total. It covered:
- 60 safety configs: 15 per policy, including the `hidden_seq` configs present in the directory;
- the 6 full liveness configs;
- `MC_full_enabled_check`.

There were no TLC errors.

**Full policy, old (eb42064d82 model) vs new (distinct states; all hold):**

| config | AtMostOnce / NoFalseConfirm / NoActOnOrphan | old states | new states |
|---|---|---|---|
| slowincl | holds | 91865 | 91865 |
| hidden | holds | 561670 | 561670 |
| hidden_seq | holds | 561670 | 561670 |
| dropped | holds | 235781 | 235781 |
| lostack | holds | 252780 | 252780 |
| stale | holds | 306338 | 306338 |
| **reorg** | holds | 526792 | **525449** |
| **reincl** | holds | 723980 | **722869** |
| hidden_reorg | holds | 2700886 | 2700886 |
| stale_reorg | holds | 1294140 | 1294140 |
| dropped_shared | holds | 235781 | 235781 |
| stale_shared | holds | 306338 | 306338 |
| nofault_any | holds | 213048 | 213048 |
| hidden_any | holds | 1308298 | 1308298 |
| dropped_shared_any | holds | 541580 | 541580 |
| enabled_check (EnabledMatches) | holds | 818 | 818 |

| liveness (full, NI = 1) | EventuallyResolved | EventuallyCorrect | old states | new states |
|---|---|---|---|---|
| live_hidden | holds | holds | 7028 | 7028 |
| live_dropped | holds | holds | 3731 | 3731 |
| live_lostack | holds | holds | 4767 | 4767 |
| live_stale | holds | holds | 8258 | 8258 |
| live_reorg | holds | holds | 12031 | 12031 |
| live_reincl | holds | holds | 7859 | 7859 |

**Baselines.** Every "holds" count of `nonce_only`, `verify_binary` and `none` equals the saved logs, as expected
because `Poll` and `TxStatus` are full-only. The violated properties per cell are the same as in the table above:
- `nonce_only`: O after a reorg (reorg, reincl, hidden_reorg, stale_reorg).
- `verify_binary`: A on lostack, slowincl and every reorg config; O on every reorg config; F on dropped_shared_any.
- `none`: A wherever the table says.
- `hidden_seq` is not in the table above. It violates A for `verify_binary` and `none`, as the saved logs already
  recorded, and holds for `nonce_only` and `full`.

There is no new counterexample. Some baseline traces differ from the saved ones by one state, or have the same length
with different steps (for example `nonce_only_reincl` O: 6 → 7, `verify_binary_reincl` O: 7 → 6). The baseline actions
are unchanged, so this comes from multi-worker search order: with several workers, TLC's trace is not guaranteed to be
the shortest. The saved `traces/` are kept as they were.

**Reachability of the new branch.** `MCWitness`, a scratch module extending the model, checks two action properties on
`MC_full_reorg` that are expected to be violated:
- W1: a `Poll` step changes another ledger record. Violated (9 states).
- W2: a `Poll` step ends the call and turns another record into `orphaned`, i.e. the guard refuses. Violated (10
  states).

Both traces are in `runs/2026-11-16/traces/witness_*`; the module is `runs/2026-11-16/MCWitness.tla` (run it with a copy of `EvidenceLayer.tla` and `MC_full_reorg.cfg` plus `PROPERTIES W1` or `W2`). W2 is the C10 situation:
1. intent 1 is confirmed at K = 2;
2. intent 2 is queued at nonce 1;
3. a depth-2 reorg orphans intent 1;
4. intent 2's round ends with `nonceLatest` 0 < 1, the guard re-checks intent 1, which becomes `orphaned`, and the call
   ends with EVIDENCE_UNRESOLVED.

The raw log of W2 (state 9 → 10) shows the change directly:
- record 1 (intent 1, nonce 0) goes from `confirmed` to `orphaned`/`orphaned`;
- record 2 (intent 2, nonce 1) is left `pending`/`wait_and_recheck` with `rounds` 1 and is not closed.

`trace_summary.py` prints `ledger=[]` in all witness and saved traces, because its record regex expects `intent` as
the first field and TLC prints `state` first. This was already true of the saved traces, and the tool is left unchanged.

Before the change, that call ended with EVIDENCE_PENDING (`wait_and_recheck`). NoActOnOrphan held then too, because
intent 2 was let through before the reorg.

The witness needs a confirmed (K = 2) dependency to be orphaned while a later send is still queued, which takes a
depth-2 reorg. That is consistent with only `reorg` and `reincl` changing while the depth-1 compound configs keep their
counts. It is an inference: W1/W2 were not run on the depth-1 configs.

**What the liveness configs do not exercise.** The liveness configs have NI = 1 and `MaxStatus` = 0, so the
post-dispatch guard cannot refuse (there is no other intent) and `tx_status` is off. Their unchanged results therefore
say nothing about the new refusal path. Liveness after an EVIDENCE_UNRESOLVED refusal, which gives no ask_user, is not
checked.

`runs/2026-11-16/SHA256SUMS` hashes the inputs and the raw logs, with relative names; the jar is listed by its bare
filename. The hashes were taken after the run completed, not at launch.

### Paper statements against the final source (within the stated bounds)

- **Holds:** "full: AtMostOnce, NoFalseConfirm, NoActOnOrphan hold in all checked configs". This now covers all 15 full
  safety configs on the updated model.
- **Holds, with a caveat:** "liveness holds under the stated bound". The six configurations re-checked unchanged, but
  they cannot reach the new refusal path (see above).
- **Holds:** "nonce_only violates NoActOnOrphan after reorg".
- **Holds:** "verify_binary duplicates on lost ack/reorg". It also duplicates on slow inclusion, as before.
- **Not modelled:** approvals, allowance effects, quorum and the harness reconciliation (97077add94). The approval-path
  scenario of e1c82ae7a3 (C10) is covered by `evidence-formal.test.ts`, not by the model. The model checks only the
  generic post-dispatch recheck that e1c82ae7a3 added.
