# WS-E report: chain-evidence layer and robust method (interim)

Branch `ws/evidence` (base 879c507645). Status: the layer, its tests and the harness/verifier changes are done and committed. Two full-layer naive cohorts pass. **The rest of the cohort batch was still running at handback** (scratchpad `batch.sh`, log `batch.log`). Mock mode and unit tests only; no paid calls.

## File-by-file changes
- `plugins/plugin-wallet/src/chains/evm/evidence.ts` (new):
  - intent ledger keyed by `chainId|sender|effectiveTarget|selector|tokenIn|tokenOut|amountIn` (in memory, one per chain and sender per process);
  - `sendWithEvidence`: pinned nonce from 'pending'; re-send with the same nonce, the stored calldata and fees +12.5%;
  - check loop (t=5 s, T=60 s); stops early on confirmed, failed, orphaned or resend_same_nonce;
  - the decision table (K=2, N=6) and the guard (EVIDENCE_UNRESOLVED);
  - EVIDENCE_PENDING errors carry `data.evidence`;
  - agent-facing messages, using the spec wording;
  - ablations (`EVM_EVIDENCE_ABLATE`);
  - refusal-sentence decoding from caveat terms.
- `__tests__/evidence.test.ts` (new, 26 tests):
  - one test per decision row;
  - flag-unset call-argument snapshots for swap.ts and plan-guard.ts;
  - "nonce too low" → landed;
  - different intent refused while one is unresolved;
  - reorg after confirmation refused;
  - ablations;
  - guarantee test over the four faults (at most one canonical transaction per nonce, exactly one sale; no_nonce_pin duplicates in the landed cells);
  - refusal decoding.
- `actions/swap.ts`: Uniswap V2 send and token-approval send go through `sendWithEvidence` only when `EVM_EVIDENCE_LAYER=1`. The else-branch is the original code.
- `plan-guard.ts`:
  - redemption through the layer when the flag is set; a repeat of an open intent re-sends its redemption without re-simulating;
  - the refusal keeps the prefix `Refused by the approved plan (` verbatim and appends `. <decoded sentence>` (flag on, ablation not no_refusal_decode).
- `actions/onchain-read.ts` (`tx_status`): with the flag set, runs one read-only check of the open intent, or of the intent that sent the given hash. Otherwise it is unchanged.
- `run-v2.ts`:
  - `--evidence` (child env `EVM_EVIDENCE_LAYER=1`, manifest `evidence`, `-ev` in the ID prefix);
  - `--evidence-ablate=<x>` (implies `--evidence`);
  - `--mock-agent=naive`;
  - `--idle-block-ms`;
  - `nonce` recorded on each transaction record.
- `verify-v2.py`:
  - accepts `manifest.evidence` and `evidenceAblate`;
  - `-ev` must appear exactly when the flag is set;
  - at most one canonical transaction per (sender, nonce), and canonical nonces must equal before..final;
  - plan modes: at most one successful redemption per plan step (decodes the redeemDelegations context).
- `test-verify-v2.py`: new tamper case "second canonical transaction for one nonce".

## Acceptance outputs so far
- **Unit suites** (pinned Node 24.15.0; vitest via startVitest with conditions eliza-source,node,development|production):
  - wallet: **256 passed + 1 skipped** (230 + 26 new);
  - core: 382 passed + 2 known logger.native-esm failures;
  - assistant: 2743 passed;
  - anthropic: 29 passed.
- **Naive + full layer, stock** (`results-wse-dev-naive-ev-stock-01`, run with the committed final code): audit PASS, 11/11 tamper rejected, 4/4 controls valid.
- **Naive + full layer, plan_guard** (`results-wse-naive-pg-full`): audit PASS, 11/11 tamper rejected, 4/4 controls valid.

| folder | condition | layer | ablation | cell | sale sends (journal) | canonical sales | duplicate | naive repeat | max canonical per nonce | executed wallet results, in order |
|---|---|---|---|---|---:|---:|---|---|---:|---|
| results-wse-dev-naive-ev-stock-01 | stock | on | none | receipt_hidden | 2 | 1 | False | True | 1 | fail:Your swap was probably included (the account's n ; ok:Submitted swap on mainnet: 0xd1f5562a3f3b2e6da0e ; ok:Submitted swap on mainnet: 0x787b9487c8ba15f891d |
| results-wse-dev-naive-ev-stock-01 | stock | on | none | sale_dropped | 2 | 1 | False | True | 1 | fail:Your swap was not found on chain and the account ; ok:Submitted swap on mainnet: 0x16bb77049197a8ea2a5 ; ok:Submitted swap on mainnet: 0x0c07ba11a8681c63232 |
| results-wse-dev-naive-ev-stock-01 | stock | on | none | rpc_stale | 2 | 1 | False | True | 1 | fail:Your node has not advanced for 60 s; balances re ; ok:Submitted swap on mainnet: 0xa10193c7e2a11bab346 ; ok:Submitted swap on mainnet: 0xd16fc374158fa60a3b7 |
| results-wse-dev-naive-ev-stock-01 | stock | on | none | sale_reorged | 2 | 1 | False | True | 1 | fail:Your swap was confirmed in block 26250602, but t ; ok:Submitted swap on mainnet: 0xe549708e3241b807033 ; ok:Submitted swap on mainnet: 0xe937624df6e3a543653 |
| results-wse-naive-pg-full | plan_guard | on | none | receipt_hidden | 2 | 1 | False | True | 1 | fail:Your swap was probably included (the account's n ; ok:Submitted swap on mainnet: 0x774b017be5efe52ccff ; ok:Submitted swap on mainnet: 0x37bdcd408e64ca80743 |
| results-wse-naive-pg-full | plan_guard | on | none | sale_dropped | 2 | 1 | False | True | 1 | fail:Your swap was not found on chain and the account ; ok:Submitted swap on mainnet: 0x491c33290940ed1334a ; ok:Submitted swap on mainnet: 0xaf60a8db380c14832d2 |
| results-wse-naive-pg-full | plan_guard | on | none | rpc_stale | 2 | 1 | False | True | 1 | fail:Your node has not advanced for 60 s; balances re ; ok:Submitted swap on mainnet: 0xc8bab366ffc83ce1421 ; ok:Submitted swap on mainnet: 0x67f43155744c2e36fb0 |
| results-wse-naive-pg-full | plan_guard | on | none | sale_reorged | 2 | 1 | False | True | 1 | fail:Your swap was confirmed in block 26250605, but t ; ok:Submitted swap on mainnet: 0x871f553bf8fe9fc71de ; ok:Submitted swap on mainnet: 0x6a96ac198b29ee100ab |

Tamper output (plan_guard, full layer):
```
PASS (rejected) outcome flag flipped -> outcome flag
PASS (rejected) final balance edited -> final balance differs from recorded effects
PASS (rejected) harness label in a request -> harness label in a model request
PASS (rejected) call response removed -> unexplained or missing call records
PASS (rejected) confirmation text changed -> a confirmation request must get the confirmation text
PASS (rejected) declared word changed -> declared outcome re-parse
PASS (rejected) transaction dropped -> canonical nonces differ from the nonce range
PASS (rejected) credential pasted -> credential pattern in
PASS (rejected) episode removed from marker -> complete run must contain every planned episode
PASS (rejected) fault event removed -> dropped first candidate
PASS (rejected) second canonical transaction for one nonce -> second canonical transaction for one nonce
```

## Pending at handback (batch running)
- No-layer arm, stock and plan_guard.
- Ablations no_nonce_pin, no_grading and no_refusal_decode, each for stock and plan_guard.
- Regression: default four (stock) and distinguishing three (plan_guard), each with and without --evidence.
- Refusal check (existing_controls, price_worse, --evidence).

Each cohort writes `results-wse-<name>{,.console.log,.audit.json,.tamper.txt}`. Fill the table with `python3 -I naive-table.py <folders>`. Typecheck could not run (tsc: missing 'bun' type definitions in this environment).

## Deviations (with reasons)
1. **Idle-block producer** (`--idle-block-ms`, default 30000 under --evidence). The fork automines only on a send, so with K=2 no confirmation ever arrives and multi-transaction flows deadlock under the guard.
   - The parent mines one empty block through the fault proxy (so it is serialized with the fault handling) after 30 s without a block, while a child runs.
   - 30 s > REORG_DELAY_MS (20 s) + one poll, so sale_reorged is orphaned before K is reached.
   - The no-layer naive arm is run with the same flag for comparability.
2. **N=6 counts check rounds** (one send's check loop, or one tx_status/guard call), not polls. Counting polls would reach ask_user at 30 s, before T=60 s.
3. **Guard states.** 'included' is also derived from eth_getTransactionByHash (block number and hash) when the receipt is hidden. Without this, the receipt_hidden control, which is not WS-E-owned and does not repeat the sale, could never reach step 2. The decision itself stays wait_and_recheck (confirmed still needs a receipt, or the landed path).
4. **Confirmed intents are re-checked before another send** and downgraded only on positive reorg evidence: the block at that height has another hash and the same number. A stale read does not count.
5. **Error code without editing the shared enum.** EVIDENCE_PENDING / EVIDENCE_UNRESOLVED are an `EvidenceError` subclass of EVMError with a cast code; this avoids editing the shared enum outside the owned files.
6. **Naive agent implemented in run-v2.ts's mock gate.** The gate reads the first non-proposal WALLET_SWAP tool result and, if it failed, re-posts the turn context with the retry inserted. The egress proxy is not owned by WS-E, so it was left untouched. Only the OpenAI (luna) tool-message format is handled.
7. **BalanceFloorEnforcer sentence lists every floor of the step,** since the reason does not name the token.

## Open problems
- The ID prefix is `-ev` for every ablation; the ablation is recorded only in the manifest.
- 'dropped' is not "unresolved" (as the spec says), so a different intent can take the dropped nonce. A later same-intent re-send then gets "nonce too low" and reports landed or ask_user. This is safe, but noisy.


## Codex recovery takeover (14 November 2026)

The user asked Codex to continue the coordinator work while Claude Code was
unavailable. Work is isolated on `research/evidence-recovery-1114` in
`/private/tmp/eliza-evidence-recovery-1114`; original worktrees and their
running validation sources remain unchanged. This recovery branch integrates
the coordinator harness so its new batch uses disjoint port bases. No original
branch has been merged or moved. No paid calls were launched.

Recovery fix commits: `8886759786`, `ce3baafc4e`. Integration: `6d07cc65ea`.
The first retains the intent before dispatch, serializes sender reservation and
send preparation, requires positive canonical evidence, and lets positive
reorg evidence supersede landed state. The second clears obsolete landed state
when a replacement is accepted. Completed identical swaps remain repeatable;
the guarantee is explicitly scoped to unresolved tracked operations within
the process, not durable logical-operation identity.

Four regressions fail on the old module (4 failed / 26 passed) and all 30
evidence tests pass on fixed code. Final wallet suite: 260 passed, 1 skipped;
assistant 2743 passed; Anthropic 29 passed; core 382 passed plus the 2 known
logger environment failures. Wallet production typecheck now passes after
restoring the installed Bun types link locally, with no manifest/config edit.
Repository `bun run verify` stops at existing app translation-key gaps; app/UI
files are unchanged. Initial EPERM listener failures are retained separately
from the passing unsandboxed local-server test runs.

Real-fork deterministic probes compared original/fixed modules. With a lost
broadcast acknowledgement, original sends used nonces [0,1], yielding two
canonical sales and 475261497 X units; fixed attempts used [0,0], yielding one
sale and 237636476 X units. When the first hash is unknown, fixed code honestly
asks the user instead of claiming a confirmed hash. An unavailable canonical
block lookup returned confirmed with canonical=null originally; fixed code
returns EVIDENCE_PENDING. Probe artifacts and exact outputs are in
`test-results/evidence-recovery-1114/`.

A new 16-cohort free matrix is running with fresh
`results-wse-recovery-1114-*` destinations. It covers full/no-layer/three
ablations in stock and plan_guard, both regression families with and without
evidence, decoded refusal and agent2 integration. All arms share idle-block
settings. Expected no_nonce_pin duplicate effects in plan_guard must not be
asserted blindly: PlanStepEnforcer independently refuses duplicate steps.
Report actual canonical counts and refusals.

The local restart handoff is
`research/notes/codex-recovery-handoff-2026-11-14.md` (ignored by existing repo
rules, intentionally left local). The automatic finalizer appends the final
cohort results here and to that handoff, then commits/pushes this existing
tracked report if source is unchanged and the secret scan passes. No merge is
automatic. Do not launch a duplicate batch while parent PID 96503 is alive.
