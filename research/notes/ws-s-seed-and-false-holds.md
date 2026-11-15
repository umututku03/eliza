# WS-S: anonymisation seed (re-freeze plan) and false-hold instrumentation

15 Nov 2026, branch `ws/seedhold`. Mock mode and unit tests only.

## 1. Anonymisation seed: not changed; re-freeze needed

`research/agent-harness-v2/fork-oracle.ts` derives the fork-only agent key as `keccak256(toHex(seed))`. The seed names
the old project. The derived address `0x6FF2e0DA2E0bcb67e7F5a7Cf55B2D2Fe92046aE0` is frozen in the task files, so the
seed was **not** changed. Changing it would break the frozen tasks: verify-v2 checks a workflow task's holder and
sender against `frozen.agent`. A guard now enforces this. run-v2 refuses a task whose `agent` differs from the address
fork-oracle derives, and verify-v2 checks the manifest `sender` against the task's `agent`. So a seed change without a
re-freeze fails loudly instead of producing runs that silently disagree with the frozen tasks.

The neutral seed would be `agent-harness-v2/fork-test-key/v1`, which gives
`0xC166A094A9f9aE958B1530a34aebd4d39f01db5f`.

**Where the old address appears:**

| File | Status | Role |
|---|---|---|
| `research/benchmark/tasks.json` (D1, H1, H2, H3) | frozen (PREREGISTRATION §9) | `agent` field |
| `research/benchmark/tasks-workflows.json` (A1, L1) | frozen | `agent` field; verify-v2 checks it for workflow tasks |
| `research/agent-harness-v2/frozen-task.json` | frozen (legacy D1) | `agent` field; run-v2 copies it into the D1 task |
| `research/plan-guard/fixtures/frozen-task.json` | copy of the above | not read for `agent` (fork-test.ts uses its own key) |
| `plugins/plugin-wallet/.../evidence.test.ts`, `wallet-router.test.ts`, `onchain-read.test.ts`, fixtures `h8-sale.json`, `h9-bridge.json`, `unavailable-analytics.json`; `plugins/plugin-assistant/.../financial-observations.test.ts` | unit tests | arbitrary address constants; nothing derives them |

The committed audits contain no copy of the address.

**Dry run (done, not committed):** calibrate-tasks.ts and calibrate-workflows.ts were re-run with the new seed, from
temporary copies on ports 9350 and 9360, writing outside the repository. Compared with the frozen files, the only
differences were `agent` in all six tasks, plus `createdAt`. Proceeds, budgets, reserves, goals and mover amounts were
identical. The fresh key has no mainnet history and is funded identically, so the calibration does not depend on the
address.

**Minimal re-freeze (needs approval):**
1. Change the seed in fork-oracle.ts.
2. Write a dated §9 amendment in PREREGISTRATION.md that records:
   - the reason (double-blind anonymity);
   - that only `agent` changes;
   - the old and new SHA-256 of `tasks.json` and `tasks-workflows.json`.
3. Replace `agent` in the three frozen files and the plan-guard fixture, either by:
   - re-running the two calibrators into new files and diffing them, which must show only `agent` and `createdAt`; or
   - a scripted field replacement checked by the same diff.
4. Optionally swap the unit-test constants for the new address.
5. Repeat the quick mock gate (one cohort per agent, plus `test-verify-v2.py`).

Runs made before the change stay verifiable only at their own commit, which is already true after any harness change.

**Other identifying strings in code paths:**
- In the files above, only the seed affects runs. Every other `spartan` / `umututku03/spartan-agent` mention in
  `research/agent-harness-v2/*.ts|py` is a provenance comment.
- `fork-oracle.ts` throws a message that names `research/agent-flow-cohorts/.env`, the old repository's layout.
- `plugins/plugin-wallet/src/analytics/news/services/newsDataService.ts` sends `User-Agent: SpartanBot/1.0`. This is
  upstream code; the harness network guard allows localhost only, so it is not used in runs.

## 2. False holds

Definition (protocol-freeze draft): a hold is a non-confirmed decision returned while the oracle predicate already held
(canonical inclusion, the matching effect, K = 2 confirmations), outside a 5 s grace window.

**Decision log.** Under `EVM_EVIDENCE_DECISION_LOG=1`, which run-v2 sets in the full arm only, evidence.ts writes one
`[evidence-decision] {json}` line to the episode's stderr for each decision it returns. There are four sites:
- `send`: the end of the check loop;
- `send_unacknowledged`;
- `guard`: the refused send reports the earlier intent's decision;
- `check`: tx_status.

The line carries the decision, wait reason, intent key and effect, hashes, pinned nonce, and the latest observation's
blocks, confirmations and times. It is logging only. A unit test runs every site with the flag unset and set and
requires identical results, messages, records and viem arguments. With the flag unset, nothing is written.

**Chain truth.** While each full-arm episode runs, run-v2 polls the direct Anvil every 250 ms, never the fault proxy.
It records:
- each head change;
- each new block, with its parent and seen times;
- the sender's transactions, with receipt status and Transfer/Approval logs.

This goes into `episode.chainTruth`. verify-v2 checks that it links up and that its canonical transactions equal the
scored ones.

**Predicate (metrics.py, post hoc).** At decision time T, take the last head recorded at or before T and walk back
through its parents. The predicate holds if a canonical block B satisfies all of:
- B holds one of the intent's transactions (by hash, or by sender and pinned nonce);
- the receipt status is success;
- the effect is in the receipt:
  - balance increase: a Transfer of the token to the holder;
  - allowance: an Approval of at least the amount;
  - native token or no effect: status only;
- head − B + 1 ≥ 2.

A hold is a decision of `wait` (any reason, including the stale-view wait), `wait_and_recheck`, `ask_user` or `landed`.
It is a false hold when the predicate has held continuously since a time S with T − S ≥ 5 s.

**Limits:**
- Block times are the poll answer times, so they are late by at most 250 ms. False holds can therefore only be
  undercounted, and only near the 5 s boundary.
- Both timestamps come from the same host's wall clock.
- The effect is read from receipt logs, not from balances at T.
- In fault cells the agent's view is faulted by design. A predicate-true hold there measures the fault, not the
  overhead, so the protocol's rate is read on `normal`.


## Takeover verification (Codex, 15 November)

The original results-wss-ev-d1 cohort at 6dce2829ce completed. Its independent audit passes and all 18 tamper cases are rejected; raw reports are retained locally. The frozen task files and original seed remain unchanged at this stage. Integration preserves the logging-only behavior while retaining the later correctness fixes to operation identity, nonce reservations and reorg recovery.

The 250 ms interval is a target sampling period, not a guaranteed RPC latency bound. False-hold counts use sampled chain state and receipt effects; they are not exact wall-clock or balance-history proofs. The no-fault rate and fault-induced holds must be distinguished.

Authored-by: Codex (OpenAI).

## Neutral identity amendment executed (15 November)

The subsequent auto-mode authorization covers the proposed free re-freeze. The fork seed and the four task-file agent fields now use the neutral identity. Structural comparison confirms that no other task field changed, including timestamps and monetary constraints. Exact old/new file hashes are appended to PREREGISTRATION §9. Final-source fork mocks are required before integration; no paid check is authorized. Unit-test arbitrary-address constants remain historical fixtures.
