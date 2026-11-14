# Spec: chain-evidence layer for the wallet plugin (next week's build)

Status: 2026-11-14, written by Claude. Implementer: Codex. Reviewer: Claude.
- **Branch:** `research/evidence-layer`, worktree `eliza-evidence`. Merge in `research/chain-faults` first, once it is accepted.
- **Design rationale:** `paper-draft/evidence-layer-design-2026-11-14.md` (local).
- **No paid model calls.** All validation is unit tests plus mock harness runs.

## Goal in one line

The chain's nonce gives safety: at most one transaction per user intent, whatever the evidence. Graded chain evidence gives progress: whether to proceed, wait, re-check, re-send with the same nonce, ask the user, or stop. The agent sees both in every wallet result.

## Scope

**New:**
- `plugins/plugin-wallet/src/chains/evm/evidence.ts`, the layer;
- `plugins/plugin-wallet/src/chains/evm/__tests__/evidence.test.ts`.

**Changed (minimal, all behind `EVM_EVIDENCE_LAYER=1`; with the flag unset, behaviour must be byte-for-byte the current path):**
- `chains/evm/actions/swap.ts`: `executeUniswapV2Quote`, the stock send at ~L841–850, and the token-approval send it uses;
- `chains/evm/plan-guard.ts`: the redemption send at L134–135, plus refusal decoding in the `throw` at the end;
- the wallet router action: add a read-only subaction `tx_status`.

**Harness:**
- `research/agent-harness-v2/run-v2.ts`: flag `--evidence` sets `EVM_EVIDENCE_LAYER=1` for the episode and control children, records `evidence: true` in the manifest, and adds `-ev` to the episode ID prefix;
- `verify-v2.py` and `test-verify-v2.py`: see below.

**Do not touch:** other aggregator paths (LiFi, Bebop, Kyber), `research/benchmark/`, frozen task files.

## Module `evidence.ts`

### Intent ledger (in memory, per wallet service instance)
- **`intentKey`:** `chainId | sender | effectiveTarget | selector | tokenIn | tokenOut | amountIn` (lower-case, decimal amount).
- **Record fields:**
  - `pinnedNonce`, `hashes[]` (every hash sent for this intent);
  - `snapshot`: the token balances the intent changes, read before the first send;
  - `state` ∈ {`sent`, `pending`, `included`, `confirmed`, `dropped`, `orphaned`, `refused`, `failed`};
  - `observations[]`, each with `{atMs, head, hash, receiptBlock, receiptBlockHash, canonical, confirmations, nonceLatest, balanceEffectSeen}`.
- **Guard:** while any intent is unresolved (`sent`, `pending`, `included` with fewer than K confirmations, or `orphaned` and not yet re-sent), a send for a **different** intent throws `EVIDENCE_UNRESOLVED`. The message names the open intent and tells the agent to check its status first. A send for the **same** intent goes through the re-send rule (below), never as a fresh nonce.

### `sendWithEvidence({walletClient, publicClient, request, intent})`

**First send:**
1. `pinnedNonce = getTransactionCount(sender, 'pending')`, read once.
2. Send with an explicit `nonce: pinnedNonce`.
3. Record the hash.

**Check loop**, at most `CHECK_BUDGET_MS = 60_000`, which equals the current receipt timeout. Poll every `t = 5 s`. Each poll records one observation:
- for every hash, `getTransactionByHash` and `getTransactionReceipt`;
- if a receipt exists, `getBlock(receiptBlock).hash` compared with `receipt.blockHash`, to detect orphaning;
- `getBlockNumber` → confirmations, and whether the view is advancing;
- `getTransactionCount(sender, 'latest')` → whether the pinned nonce is consumed;
- the token balance(s) of the intent, compared with the snapshot.

**Re-send (same intent):** send a replacement with **the same `pinnedNonce`**. Use the same calldata and a fee bump of at least 10%, so the node accepts it as a replacement.
- "nonce too low" from the node is **not** an error. It is `landed` evidence: verify the balance effect.
- "replacement underpriced" or "already known" counts as `pending`.

### Decision table (fixed constants: K = 2, t = 5 s, T = 60 s, N = 6 unresolved checks)

| Evidence (latest observation) | `decision` |
|---|---|
| receipt `0x1`, block canonical, confirmations ≥ K, balance effect seen | `confirmed` (the action returns success) |
| receipt `0x1`, confirmations < K | `wait` |
| receipt `0x0` (reverted) | `failed` (unchanged behaviour: a revert error) |
| no receipt; transaction known **or** nonce consumed | `wait_and_recheck`: "probably landed — do not send again" |
| no receipt; transaction unknown; nonce not consumed; ≥ T since the last send | `resend_same_nonce` |
| receipt seen earlier, but the block hash at that height has changed and the transaction is unknown | `orphaned` → `resend_same_nonce` |
| head not advanced for ≥ T while unresolved | `wait`: "your node may be behind; balances read now may be stale" |
| replacement rejected with "nonce too low" | `landed`: verify the balance effect → `confirmed`, or `ask_user` if the effect never appears |
| still unresolved after N checks | `ask_user`: stop, and report exactly what is known |

**When the check budget ends without `confirmed`:** the action does **not** report a generic failure. It throws `EVMError(EVIDENCE_PENDING)`. Its message is one plain sentence built from the decision (examples below), and `data.evidence` carries the full record. **The layer never re-sends on its own.** `resend_same_nonce` is carried out on the agent's next call for the same intent, which goes through the normal confirmation flow. The user's approval therefore still gates every transaction.

**Example messages** (keep this wording; it is what agents read):
- `wait_and_recheck`: "Your swap was probably included (the account's nonce moved) but its receipt is not visible yet. Do not send it again; check its status with tx_status."
- `resend_same_nonce`: "Your swap was not found on chain and the account nonce is unchanged, so it was dropped. Repeating the same swap is safe: it reuses the same nonce, so at most one can execute."
- `orphaned`: "Your swap was confirmed in block B, but that block is no longer part of the chain (reorg). The swap is not on chain now. Repeating the same swap is safe (same nonce)."
- `wait` (stale): "Your node has not advanced for 60 s; balances read now may be out of date. Wait and check the status again before acting."

### Refusals the agent can act on (`plan-guard.ts`)

When the final `throw` reports `Refused by the approved plan (<Enforcer>:<reason>)`, decode the signed caveat terms of the matching step from `EVM_PLAN_GUARD_PLAN`, and append one sentence:

| reason | Sentence |
|---|---|
| `ERC20BalanceChangeEnforcer:exceeded-balance-decrease` | "This step may spend at most C <X>; you asked for A." |
| `ERC20BalanceChangeEnforcer:insufficient-balance-increase` | "This step must yield at least G <Y>." |
| `AllowedCalldataEnforcer:invalid-calldata` | "This step only accepts amount B <X>." |
| `BalanceFloorEnforcer:*` | "After this step the account must still hold at least R <token>." |
| `PlanStepEnforcer:*` | "This step is not allowed now: prerequisite not done, or already done." |

**Keep the existing prefix verbatim.** `analyze-sweep.py`'s `REFUSED` regex depends on it.

### `tx_status` subaction

A read-only subaction that runs one check of the open intent, or of a given hash, and returns the latest decision and evidence. It must not send anything.

## Harness and verifier

- **`--evidence` records the flag** in the manifest and in each episode's spec. The episode and control children get `EVM_EVIDENCE_LAYER=1`.
- **Verifier:**
  - accepts `manifest.evidence`;
  - checks that the ID prefix has `-ev` exactly when the flag is set;
  - checks that every agent send with `nonce == pinnedNonce` of an intent is either the one canonical execution or a non-canonical, dropped or replaced transaction. **At most one canonical transaction per (sender, nonce).** The chain guarantees this; the check guards against harness errors.
- **Tamper test, new case:** "second canonical transaction for one nonce". Duplicate one transaction record with the same nonce and a different hash; the verifier must reject it.

## Acceptance (unit tests and mock mode only)

1. **`evidence.test.ts`** (mocked viem clients), one test per decision row, plus:
   - with the flag unset, `sendTransaction` is called exactly as before (snapshot of the call arguments);
   - "nonce too low" on re-send is classified as `landed`;
   - a different intent is refused while one is unresolved.
2. **Wallet unit suite:** 230 passed, 1 skipped, plus the new tests. Core, assistant and anthropic suites are unchanged.
3. **The key mock test, a naive re-sender.** Add a mock plan variant, `--mock-agent=naive`. Whenever a sale call does not return success, it repeats the sale once, like the measured LLM failure. On the four 2×2 scenarios (`receipt_hidden`, `sale_dropped`, `rpc_stale`, `sale_reorged`):
   - **without** `--evidence`: duplicate sales appear in the landed cells (`receipt_hidden`, `rpc_stale`). Record this as the expected failure;
   - **with** `--evidence`: **zero duplicate sales in all four cells**, and exactly one canonical sale in the not-landed cells.

   Run both stock and `plan_guard`.
4. **Regression:** the default four scenarios and the three distinguishing states, mock luna, with and without `--evidence`. Audit PASS and full tamper rejection.
5. **Refusal message check:** in `price_worse` under `existing_controls` (mock), the control's refusal text contains the decoded bound "may spend at most 59.406476".

## Report

Commit in small steps on `research/evidence-layer` and push. Write `research/notes/codex-report-evidence-layer.md` with:
- file-by-file changes;
- exact outputs for each acceptance item;
- deviations, with reasons;
- open problems.
