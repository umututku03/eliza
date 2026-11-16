# Spec: named baselines for the evidence-layer evaluation (15 November 2026)

Status: 2026-11-15, written by Claude. It answers Codex's readiness gates in `main-study-protocol-draft.md` (readiness addendum). Implementer: a subagent on branch `ws/baselines`, from `cdc7009fae`. **Mock and unit tests only; no paid calls.**

## Decision recorded
- **Protected comparisons** (all arms below) run on **ElizaOS only**.
- **agent2** stays in the study as a no-defence agent, for framework dependence. No agent2 evidence adapter is built (Codex's gate: "or restrict protected comparisons to ElizaOS").

## One switch for all arms
- **Harness flag:** `--arm=none|prompt_only|nonce_only|verify_binary|full|pace_style|full_quorum|patient`, recorded as `manifest.arm`. Episode IDs get an arm tag: `-none`, `-po`, `-no`, `-vb`, `-ev`, `-ps`, `-fq`, `-pt`.
- **Compatibility:** the existing `--evidence` maps to `--arm=full`, and `--evidence-ablate` stays for ablations under `full` only.
- **Wallet side:** `EVM_EVIDENCE_MODE` = `full | nonce_only | verify_binary | pace_style | full_quorum | patient`. When unset, the stock path is byte-identical (keep the existing call-argument snapshot tests).
- **Equal across arms:** idle blocks, fault parameters, task text, tools and models. The arm is the only difference.

## Arm definitions (fixed now)

### `prompt_only`
- **What:** the stock wallet, plus one fixed instruction appended to the agent's system prompt, in ElizaOS's character system text:

  > "Before repeating any transaction, check on chain whether the earlier attempt already took effect (balances, transaction status). Do not send the same trade again unless you have confirmed that the earlier attempt did not land. If you cannot tell, say so and wait."

- **Recording:** the exact text goes into the manifest, and the verifier checks it is present for this arm and absent otherwise.
- **Blinding:** it must pass the forbidden-term check (no harness labels).

### `nonce_only` (what a wallet's speed-up or cancel gives you)
- **Intent ledger and same-nonce re-send:** identical to `full`: same intent key, the pinned nonce is read once, and a re-send uses the same calldata with a fee bump of at least 10%.
- **"nonce too low" on a re-send:** reported as success, in the stock wording, because the earlier attempt landed.
- **No grading:** action results keep stock's success or failure wording; no `wait`, `orphaned` or `ask_user` decisions.
- **No guard:** a different intent is not blocked.
- **No refusal decoding.**
- **Reservation lifetime:** the pinned nonce stays reserved for its intent until the nonce is consumed on chain. A different intent while one is unresolved takes the next free nonce. **The resulting nonce gap is recorded:** if the reserved nonce was dropped, later transactions queue behind it, which is real wallet behaviour.
- **Negatives that must be checked:**
  - a lost acknowledgement (receipt_hidden): a re-send gets "nonce too low" → success, with no duplicate;
  - a reorg: a re-send with the same nonce lands once.

### `verify_binary` (Verified Tool Calls-style verify-before-retry)
- **Before re-sending an intent, one binary check:** "complete" if a receipt with status 1 exists **or** the intent's balance effect has been observed against the pre-send snapshot (read through the wallet's RPC); "incomplete" otherwise.
- **Confirmation threshold:** 1, meaning a receipt.
- **An inconclusive read counts as incomplete,** because the decision is binary, as the source describes.
- **Complete:** report success and do not re-send. **Incomplete:** re-send with a **fresh nonce** (no pinning), which is the published design.
- **Expected:** under `rpc_stale`, the stale balance and missing receipt read as incomplete, so it re-sends and duplicates. This follows from the design ("binary verification decisions"); it is not tuned against it.

### `full`
The evidence layer as merged (`evidence.ts`, with Codex's fixes), unchanged.

### `full_quorum` (WS-Q; standard-practice treatment arm, not a contribution)
- **What:** `full` with its evidence reads (head, receipts, transaction lookups, nonce, balance effect) taken from K >= 2 read endpoints and compared. This is quorum reads as in ethers FallbackProvider / eRPC consensus, applied inside the evidence layer (Helios goes further and verifies headers). `EVM_EVIDENCE_MODE=full_quorum`, `EVM_EVIDENCE_READ_URLS`, `--arm=full_quorum` (tag `-fq`).
- **Agreement rule:** see the "quorum reads" comment in `evidence.ts`, which is normative. In short, the quorum is a strict majority of K. The largest pairwise-consistent (prefix) set of endpoints is taken, and its most advanced member is used. Claims about block B are decided among the members whose head reaches B, by supporters against deniers. With no quorum, or with a tie, the layer waits (`no_quorum`) and asks the user after N rounds.
- **Harness:** K fork-RPC proxies in front of one Anvil. Proxy 0 is the wallet's RPC and the only faulted proxy, so it models "one bad provider". The other proxies are clean read endpoints.

### `patient` (added 16 Nov 2026; "would simply waiting longer do what the evidence layer does?")
- **What:** the stock wallet with **only** the receipt-wait timeout extended: `waitForTransactionReceipt` waits
  `PATIENT_RECEIPT_TIMEOUT_MS` = **300 s** instead of the stock `TX_CONFIRMATION_TIMEOUT_MS` = **60 s**
  (`plugins/plugin-wallet/src/chains/evm/constants.ts`). 300 s is five stock timeouts and five times the 60 s
  hide/lag fault windows; whether that helps depends on the stock client keeping polling (see "Expected").
- **Switch:** `EVM_EVIDENCE_MODE=patient`, `--arm=patient`, tag `-pt`. The stock send sites (`swap.ts`, `plan-guard.ts`)
  read their timeout from `receiptTimeoutMs()`; patient never enters `sendWithEvidence`.
- **Unchanged from stock:** no intent ledger, no nonce pinning, no fee bump, no grading, no guard, no refusal decoding;
  stock success and error wording (a timeout still reads "Timed out while waiting for transaction ... to be confirmed").
- **Recording:** the wallet writes the mode line `[evidence] EVM_EVIDENCE_MODE=patient` once (stderr); the manifest records
  `armEnv = {EVM_EVIDENCE_MODE: patient}` and `armReceiptTimeoutMs = 300000` (null for every other arm). The verifier
  checks arm, tag, environment, mode line and timeout; the generic "arm label changed" tamper case covers it, and
  "patient receipt timeout changed" is a patient-specific case.
- **Expected (not tuned):** it should match `full` where the fault ends inside 300 s and the stock wait keeps polling
  (rpc_stale: confirmed in the 16 Nov mock gate). It does **not** help under receipt_hidden: viem 2.56.9's
  `waitForTransactionReceipt` does not keep polling there: once `getTransaction` returns the mined transaction, a missing
  receipt triggers its replacement check, which fetches that block, finds the same sender/nonce (the transaction itself),
  asks for its receipt again and rejects on the second "not found" ("Transaction receipt ... could not be found"). The
  timeout is never reached (mock gate: rejected within seconds, then a duplicate, as in none). It
  cannot help when the sale never lands (sale_dropped: one 300 s wait, then a stock
  failure, and any re-send is a new stock transaction) or is rolled back after its receipt (reorg cells). It costs latency: each such
  wallet call blocks up to 300 s.

### `pace_style` (appendix arm; implement after the four above pass)
- **What:** a stateless per-intent check before signing: simulate the swap with `eth_call` at the head, then check the declared policy (target router, token pair, amount at most the user's stated constraint, minimum output). Approve or refuse each call independently, with **no state across calls**. This follows PACE §4.4, "pure, stateless function".
- **No nonce pinning and no grading.** Retries are new intents and are approved independently.
- **Documentation:** say exactly what is reimplemented, and that PACE's code is not public ("open-sourced upon acceptance").

## Acceptance (mock and unit; no paid calls)
1. **Unit tests per mode:**
   - flag unset → stock byte-identical;
   - `nonce_only`: same-nonce re-send; "nonce too low" → success; no guard; nonce-gap recorded;
   - `verify_binary`: complete/incomplete classification; fresh-nonce re-send; an inconclusive read → incomplete;
   - `prompt_only`: prompt text injected only for this arm;
   - `pace_style`: simulation failure → refusal; a duplicate intent is approved.
2. **Naive-agent table,** on the final code: ElizaOS, stock wallet, D1, the four core faults × the arms {none, nonce_only, verify_binary, full} (plus `prompt_only` with the normal mock plan). Every cohort audits PASS with full tamper rejection; controls are valid. Record duplicates, goal and the first evidence per cell. **Expected (not a pass criterion):**
   - none: duplicates in the landed cells;
   - nonce_only and full: 0 duplicates;
   - verify_binary: a duplicate in rpc_stale.
3. **Regression:** the default four and the three distinguishing states with `--arm=none`: identical to before.
4. **Verifier:** checks `manifest.arm`, the ID tag and the arm's environment (prompt text present or absent; mode recorded). One new tamper case: "arm label changed".

## Rules
- **Ports:** every run uses `--port-base` in 6000–6900. The default ports are used by another batch.
- **Files you may change:**
  - `evidence.ts` and its tests;
  - the minimal mode switches at the two send sites;
  - `run-v2.ts` (the arm flag and prompt injection);
  - `verify-v2.py`, `test-verify-v2.py`;
  - `scorecard.py` (group by arm).
- **Never:** formatters on harness files, frozen task files, or printing secrets.
- **Git:** small commits on `ws/baselines`, then push.
- **Report** (returned as text if a file write is blocked): file-by-file changes, the naive table, exact audit and tamper outputs, deviations, open problems.


## Takeover integration note (15 November)

The quorum arm is a standard-practice measurement treatment, not a new mechanism. Its N=2 advanced-prefix rule does not tolerate a higher-head lying provider; that limitation is explicit in the code. The first full_quorum acceptance cohort stopped at its reference control with no model episodes and zero model spend. Preserve that failed folder. The independently completed full-arm comparison remains separate.

The continuation integration retains the independently hardened full path, including canonical anchors and reported-outcome bookkeeping. Its five pre-quorum compatibility snapshots were captured before importing quorum code. The first integration run passes all 81 targeted tests. Further quorum state-read/abstention review and fresh fork acceptance remain required before coordinator publication.

Authored-by: Codex (OpenAI).
