# Bounded TLA+ model of the evidence layer (WS-T)

`EvidenceLayer.tla` models the recovery protocol of `plugins/plugin-wallet/src/chains/evm/evidence.ts` and three
baseline send policies, checked with TLC on small bounds. The top-level model follows the **hardened** wallet
(Codex commits d5b0719ef5, 74a76f672a; `evidence.ts` at `origin/research/evidence-layer` eb42064d82, quorum mode
excluded). `legacy/` keeps the model of the pre-hardening wallet (fc7ce03a5b) and the counterexamples it produced.

These are bounded results: "holds" means no violation in the finite state space of the stated bounds, not a proof.

## Running

```
./run.sh MC_full_hidden.cfg ...      # one result line per property; logs/ (ignored) and traces/
python3 -I gen_cfgs.py               # regenerates every MC_*.cfg from the bounds in gen_cfgs.py
python3 -I trace_summary.py <log>    # one line per state of a TLC counterexample
```

Tools, installed under `$HOME/tools/tla` (system Java untouched):
- Eclipse Temurin JDK 21.0.13+9 (aarch64 macOS) from the Adoptium GitHub release; SHA-256
  `bf036b35b071bfb2f54f2c0af8ee8d88afa95ee6eb3dce02c0f94cfc2524d04a` matched the published `.sha256.txt`.
- `tla2tools.jar` v1.7.4 (latest non-prerelease) from the tlaplus/tlaplus GitHub release; SHA-1
  `bee4a54f3ee3d4afc347c3240ec2d9e93b075104` matched the release notes (SHA-256 `936a2620...0e88`).

Safety runs use 8 to 10 workers. Liveness runs use one worker, as the release notes advise.

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

### Mapping (spec ↔ evidence.ts at eb42064d82)

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
| `Poll` (`late`, `mid`) | check loop, polled every t until terminal or T | Time is abstract: `sendOld` means ≥ T since the last send, `hsOld` means head unchanged for ≥ T. `TimePasses` covers agent time between calls. |
| `TxStatus` | `tx_status` → `checkOnce(latestIntent(), counted)` | — |
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
`MC_full_enabled_check.cfg`.

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

## Results (TLC 1.7.4, Apple M-series, 8–10 workers)

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
assertions. Both are `it.fails`: they fail on fc7ce03a5b's `evidence.ts` at the property assertion, and they pass
against eb42064d82's `evidence.ts`. After the merge, turn them into plain `it`.

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
