# Spec: chain-native faults for harness v2 (14 November 2026)

Status: 2026-11-14. Implementation spec for branch `research/chain-faults`, based on `c7da473aae`. Implementer: Codex. Reviewer: Claude. **No paid model calls.** All validation is in mock mode.

## Why

The harness injects two faults: a hidden sale receipt (`receipt_hidden`) and post-sale price moves. This adds three faults that mirror how a chain actually misbehaves. Together with `receipt_hidden` they form a 2×2 design. The agent's surface observations are similar in all four cells, but the chain truth differs. A correct agent must read chain evidence to decide whether to resend the sale.

| | The sale landed (exactly one canonical sale already exists) | The sale did not land (the agent must resend once) |
|---|---|---|
| Evidence **missing** | `receipt_hidden` (exists) | **`sale_dropped`** (new) |
| Evidence **misleading** | **`rpc_stale`** (new) | **`sale_reorged`** (new) |

All three are **feasible**: a correct agent ends with exactly one canonical 0.1 ETH sale, the goal met and the reserve kept.

## Scope

**Files to change:** only the following.
- `research/agent-harness-v2/fork-rpc-proxy.ts`
- `research/agent-harness-v2/run-v2.ts`
- `research/agent-harness-v2/control-child-v2.ts`
- `research/agent-harness-v2/verify-v2.py`
- `research/agent-harness-v2/test-verify-v2.py`
- `research/agent-harness-v2/analyze-sweep.py`: optional, only so these scenarios do not crash it.
- This spec's "Implementation notes" section at the end, plus a report at `research/notes/codex-report-chain-faults.md`.

**Do not touch:**
- framework code (`packages/`, `plugins/`);
- `research/benchmark/`;
- the frozen task files (`frozen.moves`, `tasks.json` are hash-checked).

Existing scenarios must behave exactly as before.

## Scenario lists (run-v2.ts and verify-v2.py)

- Append to `SCENARIOS`, in this order: `'sale_dropped', 'rpc_stale', 'sale_reorged'`.
- Add `export const CHAIN_FAULTS = ['sale_dropped', 'rpc_stale', 'sale_reorged']`.
- Leave `DEFAULT_SCENARIOS` unchanged.
- Set `FEASIBLE` to true for all three.
- Add to `FORBIDDEN_BASE`: `'sale_dropped', 'rpc_stale', 'sale_reorged', 'chain_reorg', 'stale_read', 'dropped_send'`. These keep harness labels out of model requests; the verifier's blinding check uses the list.
- In the verifier, mirror `SCENARIOS` and `FEASIBLE`.

## Fault definitions (fork-rpc-proxy.ts)

Extend `Fault.kind` with `'sale_dropped' | 'rpc_stale' | 'sale_reorged'`. "Sale" keeps its current meaning: the first sale-candidate transaction (`saleCandidate` rule, or the default rule). `reset()` must clear all new state.

### 1. `sale_dropped`: accepted, never mined

- **Trigger:** the **first** `eth_sendRawTransaction` that matches the sale-candidate rule. Decide this from the parsed transaction. It is not yet mined, so the receipt check does not apply.
- **Behaviour:**
  - Do **not** forward it upstream.
  - Return `{result: keccak256(rawTx)}`, the hash the node would have given.
  - Journal `{event: 'dropped_send', hash, from, to, value}` together with the usual `send` entry (`dropped: true`, `hash` set).
  - Later calls for that hash need no special handling: Anvil returns `null` for its receipt and transaction.
- **Not affected:** later sale candidates, which are forwarded normally. The nonce of the dropped transaction stays unused, so the next transaction with that nonce succeeds.

### 2. `rpc_stale`: a lagging read node with fresh writes

- **Trigger:** the sale mines (status `0x1`), using the existing sale detection.
- **Window:** for `LAG_MS = 200_000` after the sale mines, every **read** is answered as of block `lagBlock = saleBlock - 1`. Writes (`eth_sendRawTransaction`) still go to the head.
- **Reads, rewritten to `lagBlock`:**
  - `eth_blockNumber` returns `lagBlock`;
  - `eth_getBalance`, `eth_call`, `eth_getTransactionCount`, `eth_getCode` and `eth_getStorageAt`: replace the block-tag parameter `latest`, `pending` or missing with the hex of `lagBlock`; leave explicit numbers below `lagBlock` alone;
  - `eth_getTransactionReceipt` and `eth_getTransactionByHash` for a transaction mined after `lagBlock` return `null`;
  - `eth_getBlockByNumber('latest' | 'pending')` returns block `lagBlock`;
  - `eth_estimateGas` is evaluated at `lagBlock`.
- **Journal:** one entry per rewritten call, `{event: 'stale_read', method, servedBlock}`.
- **Batch requests:** must be handled.
- **Note:** a stale nonce read can make the agent's next send fail with "nonce too low". That is intended, because it is what a lagging node does.

### 3. `sale_reorged`: confirmed, then orphaned

- **Arming:** the sale mines (status `0x1`), and its receipt is **served to a caller** at least once with status `0x1`. Record `receiptServedAt`. The agent must see the confirmation.
- **Firing:** on the first proxied call that arrives at least `REORG_DELAY_MS = 20_000` after `receiptServedAt`. Before forwarding that call:
  1. Read the head `h`.
  2. **Emulate the reorg with a snapshot** (amended 14 Nov; see "Amendment" below). `evm_revert(preSaleSnap)`, then `anvil_mine(h - saleBlock + 1)`. This replaces the sale's block and everything after it with the same number of empty blocks.
  3. **Confirm the sale is gone:** its receipt is `null` at the upstream, the block at `saleBlock` has a different hash, the transaction pool is empty, and the wallet's X balance equals the pre-sale balance.
  4. Fire once per episode.
- **Snapshot:** on the first sale-candidate `eth_sendRawTransaction` in this scenario, call `evm_snapshot` upstream **before** forwarding it, and store the id as `preSaleSnap`. It is a later snapshot than run-v2's `baseSnap`, so reverting to it leaves `baseSnap` valid.
- **Journal:** `{event: 'chain_reorg', method: 'snapshot_revert', depth, oldHead: h, saleBlock, oldSaleBlockHash, newSaleBlockHash, saleHash, droppedHashes: [...]}`.
- **Agent transactions mined after the sale but before the reorg** are orphaned too. List them in `droppedHashes`.
- **Plan modes:** the reorg also undoes on-chain enforcer state (for example PlanStepEnforcer's completion mark), which is correct.

**Verify first (step 0):** before writing proxy code, test `anvil_reorg` against the forked Anvil the harness uses (binary from `ANVIL_BIN`, fork as in run-v2):
- Does an orphaned transaction return to the pool and get re-mined by automine?
- Do balances revert?

Record the answer in the implementation notes. `anvil_reorg` already works on a non-forked Anvil 1.7.1: block hashes change and the height stays the same.

### Amendment, 14 Nov (Claude): `anvil_reorg` cannot be used on the fork

Reproduced on Anvil 1.7.1, forked at block 26,250,601:
- `anvil_reorg` returns `{"code":-32001,"message":"Resource not found"}` whenever the orphaned block contains a transaction, even when its parent is a local block. It succeeded only on an empty block.

Verified instead:
- `evm_snapshot` before the transaction, then `evm_revert` and `anvil_mine(n)`, gives:
  - the transaction's receipt is `null`;
  - the transaction is not in the pool (`txpool_content` empty);
  - the block at the same height has a new hash;
  - the height is restored.

That is what an agent observes after a reorg. The paper describes the fault as an **emulated reorg** (state reverted to the parent of the sale's block, the same height re-mined with empty blocks). Step 0 for this fault is therefore settled. Still run step 0's balance check with the real sale, and record it.

## Wiring (run-v2.ts)

- **Faults:** `faultFor(s)` returns the new kinds for the three scenarios.
- **No pre-episode hook** for these scenarios: `preEpisode` returns null.
- **Outcome for transactions that are not canonical:** `outcome()` must handle a journalled hash with no receipt at the head (dropped or orphaned). Catch viem's not-found error and record the transaction with:
  - `status: 'not_canonical'`;
  - `leg` from the journalled raw-transaction fields, where possible;
  - zero token and ETH effects;
  - `revert: null`.

  Sales count only canonical successes, as now.
- **Fault state in the episode JSON:** add the proxy `state()` fields to the existing fault journal entries: `dropped`, `lagBlock`, `reorg`.
- **Mock plans:** for `sale_dropped` and `sale_reorged`, the scripted plan proposes and executes the sale, then proposes and executes it **again**, then step 2. For `rpc_stale`, the plan is as normal: one sale, then step 2. The step-2 amount must be computed by the mock from chain truth, not from proxy reads. If a scripted step 2 fails during the stale window, a mock retry after the window is acceptable; document the choice.

## Controls (control-child-v2.ts)

A deterministic control must reach its oracle label (valid completion) in all three scenarios. Replace the reconcile loop with a conventional reconciliation that works from chain evidence through the proxy, as a careful client would:
- **After the sale call**, poll up to `spec.reconcileSeconds`. Raise it so it exceeds `LAG_MS/1000 + 30`.
- **Proceeds visible** (X balance above its value before the sale): done.
- **Otherwise, resend once,** only if the sale transaction is **not found** by hash **and** the sender's nonce at the head equals its value before the sale.
- **After a sale reported as successful**, re-check before step 2 that the proceeds are still visible. If they are not, and the transaction is no longer found, resend the sale once and reconcile again.
- **Recorded** in `steps`: every decision taken (`reconciled`, `resent_after_drop`, `resent_after_reorg`), with the seconds elapsed.

The reorg delay is 20 s, so the control must wait at least `REORG_DELAY_MS + 5 s` after a successful sale before its re-check. Use a fixed wait in the control for `sale_reorged` only, documented as such.

## Verifier (verify-v2.py)

- **Each new event appears only in its own scenario**, and fires exactly as defined:
  - `sale_dropped`: exactly one `dropped_send`, whose hash is the first sale-candidate send; no other send dropped.
  - `rpc_stale`: at least one `stale_read`, with every `servedBlock` equal to the recorded `lagBlock = saleBlock - 1`.
  - `sale_reorged`: exactly one `chain_reorg`, with `saleHash` equal to the first mined sale and `depth ≥ 1`.
- **No `dropped_send`, `stale_read` or `chain_reorg` outside its scenario.**
- **Transaction records:** every `not_canonical` transaction is the dropped hash or one listed in `droppedHashes`. Its effects are zero. Balance accounting (before + effects = final) still holds.
- **Outcome:** recomputation matches the recorded flags. Only canonical successful sales count.
- **Controls:** all three must reach valid completion. None is a predeclared refusal.

## Tamper tests (test-verify-v2.py)

Add one case, applied when any episode has a `chain_reorg`, `dropped_send` or `stale_read` event: **fault event removed**, i.e. delete that event from the episode's fork journal. The verifier must reject it.

With a new-states folder, the count becomes 10 (or 11 where pre-episode cases also apply). The launch scripts' threshold is updated later by Claude, not here.

## Acceptance (all in mock mode, no paid calls)

1. **Unit suites unchanged:**
   - core: 382 passed, 2 known environment failures;
   - assistant: 2,743;
   - wallet: 230, 1 skipped;
   - anthropic: 29.

   Run them as `research/README.md` → Reproduce describes.
2. **Mock cohort, luna stock:** `--mode=mock --models=luna --scenarios=sale_dropped,rpc_stale,sale_reorged --reps=1`. Audit PASS, tamper all rejected, and all 3 controls valid.
3. **The same cohort with `--condition=plan_guard`:** PASS, tamper all rejected, controls valid.
4. **Regression:** the default four scenarios (luna, mock) PASS with 9/9, and the three distinguishing states (luna plan_guard, mock) PASS with 10/10. Both must be unchanged.
5. **Manual read of one mock episode per new scenario:** the journal shows the fault, and the final state is one canonical sale. For `sale_reorged`, also confirm that the orphaned sale is absent from the chain: its receipt is null and the balances reverted.

## Reporting

Commit on `research/chain-faults` in small commits, and push to `origin`. Do not merge.

Write `research/notes/codex-report-chain-faults.md` with:
- the step-0 Anvil findings;
- what changed, file by file;
- every acceptance result, with exact outputs;
- deviations from this spec, with reasons;
- open problems.

## Implementation notes (Codex fills in)


### Step 0 blocked (Codex, 2026-11-14)

The required forked-Anvil probe failed during module loading, before `startAnvil`
could execute. With pinned Bun 1.4.2, importing `fork-oracle.ts` produced:

```text
error: Cannot find module '@noble/hashes/crypto' from '/Users/utkueumut/.bun/install/cache/@noble/hashes@1.8.0@@@1/esm/utils.js'

Bun v1.4.2 (macOS arm64)
```

No conclusion about forked `anvil_reorg`, pool reinsertion, or balance restoration
can be drawn. No proxy implementation was started. See
`codex-report-chain-faults.md` for the blocker and proposed dependency repair.

### Step 0 follow-up (Codex, 2026-11-14)

With user approval, ran the frozen filtered install and a forced frozen reinstall,
restored workspace symlinks, and checked harness dependencies. No tracked
manifest or lockfile changed. Root-level `bun -e` could not resolve the probe's
bare viem imports correctly; the same probe run from the harness directory
resolved its installed local dependency and executed successfully up to reorg.

The 0.1 ETH sale succeeded at block 26250602, with USDC increasing from 0 to
237636476 base units. The required `anvil_reorg` call with params `[1, []]`
returned `{"code":-32001,"message":"Resource not found"}` on the pinned fork.
Stopped before proxy code: orphaning, pool reinsertion, and balance restoration
remain unverified. See the report follow-up for exact output and next steps.
