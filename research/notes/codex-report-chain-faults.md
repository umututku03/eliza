# Chain faults implementation report

Date: 2026-11-14. Branch: `research/chain-faults`.
Status: blocked at mandatory step 0; implementation not started.

## Step-0 findings

Read the complete specification before any changes. Confirmed the requested
branch and a clean worktree. No live sweep process was present when checked.
Attempted the fork probe using the specified Bun 1.4.2 and ANVIL_BIN, loading
FORK_ENV through `--env-file` only. The probe imported the existing fork oracle
and prepared an actual 0.1 ETH router sale, an `anvil_reorg` call, receipt and
balance checks, pool inspection, and an extra mined block.

The probe failed during module loading, before Anvil startup or any transaction.
Exact diagnostic:

```text
error: Cannot find module '@noble/hashes/crypto' from '/Users/utkueumut/.bun/install/cache/@noble/hashes@1.8.0@@@1/esm/utils.js'

Bun v1.4.2 (macOS arm64)
```

The output-filter pipeline returned 0; this is not a successful probe result.
The module-loader diagnostic prevents execution of the test itself.
Whether orphaned transactions return to the pool, get re-mined, and restore
balances on this fork remains untested.

## File-by-file changes

- `research/notes/chain-faults-spec.md`: appended the step-0 blocker to
  Implementation notes; preserved the specification.
- `research/notes/codex-report-chain-faults.md`: this report.
- No harness, framework, benchmark, frozen task, or dependency files changed.

## Acceptance results

1. Unit suites: NOT RUN; stopped at prerequisite step 0.
2. New-fault Luna stock mock cohort, audit, tamper checks, controls: NOT RUN.
3. New-fault Luna plan_guard mock cohort, audit, tamper checks, controls: NOT RUN.
4. Default and distinguishing-state regression cohorts: NOT RUN.
5. Manual new-fault episode and canonical-chain checks: NOT RUN; no new
   cohort results were produced.

There are no acceptance output lines to copy because those commands were not
executed. No acceptance check is claimed as passing.

## Deviations and proposed fix

Stopped as required by the specification's blocker rule. The error was not
`debug is not a function`, so the explicitly permitted retry did not apply.
No retry, dependency repair, or alternative proxy design was attempted.

Proposed next step: repair the existing dependency installation using the pinned
toolchain and frozen lockfile, preserving tracked source and lockfiles, then
repeat step 0. Dependency installation is outside the listed implementation
files, so this report does not perform that repair. If resolution still fails,
inspect the installed `@noble/hashes` package and Bun module resolution before
changing any implementation design.

## Open problems

- Dependency resolution prevents the mandatory pre-implementation fork test.
- All three faults, their wiring, verification and tamper coverage remain open.
- All five acceptance checks remain open.
- No paid API calls were made. No existing result folders were changed.

## Follow-up after authorized dependency repair (2026-11-14)

Ran Bun 1.4.2 frozen filtered installation, harness frozen installation,
workspace-symlink restoration, and a forced frozen filtered reinstall. The
installs succeeded without changing tracked manifests or lockfiles.
Selected exact outputs:

```text
77 packages installed [1058.00ms]
Checked 49 installs across 48 packages (no changes) [31.00ms]
2789 packages installed [17.37s]
[ensure-workspace-symlinks] created=0 skipped=218 hoisted=0 missing-roots=0
```

The original root-level eval still failed on the bare viem account import.
Running the probe in `research/agent-harness-v2`, where viem is installed as a
local dependency, resolved that import. This changes only the probe execution
location, not harness code, dependencies' declared versions, or the fault design.
Import validation output:

```text
harness account import true
```

The fork started using the existing oracle and pinned block. An actual router
sale succeeded. Exact output from the probe:

```text
{"stage":"sale","hash":"0xe8840f458f433603aadfb2b8abe7d1b68d4bdcac800aa7d3cc81ff5e13024759","status":"success","head":26250602,"saleBlock":26250602,"beforeX":"0","afterX":"237636476"}
STEP0 ERROR: Error: anvil_reorg: {"code":-32001,"message":"Resource not found"}
```

The failing call was `anvil_reorg` with parameters `[1, []]`, because head and
saleBlock were both 26250602. The probe returned exit 1 and stopped its own Anvil
process in finally. No receipt-null, pool, or post-reorg balance observations
were obtained. The successful sale is not evidence that reorg works.

Current blocker: the mandatory forked reorg call fails on this Anvil/fork
combination. The error alone does not establish whether the cause is missing
fork data, a fork-mode implementation limit, or another Anvil issue.

Proposed next step: investigate this forked `anvil_reorg` error and validate a
supported invocation or Anvil version before implementation. If a different
mechanism is needed, revise the spec explicitly; do not silently substitute
snapshot/revert for the specified chain reorg.

All five acceptance checks and chain-fault implementation remain open. No paid
calls, proxy changes, or existing-results changes were made. This follow-up
supersedes the earlier dependency blocker as the current stopping condition.

## Implementation resumed under amendment 48780b0b4a

Pulled the approved amended spec (already current locally). Before writing
proxy code, tested a real router sale followed by the amended snapshot/revert
mechanism. Exact probe output:

```text
{"hash":"0xc7d6bb6bc1b773d01dbd1ec0f01a25859b0562185947be529c7b3899f6824f04","beforeX":"0","afterSaleX":"237636476","afterRevertX":"0","receipt":null,"transaction":null,"pool":{"pending":"0x0","queued":"0x0"},"heightRestored":true,"oldBlockHash":"0xd7b7298cb343c9067b631fcbb60a113d14c57e91cebfa5ae1facee6a5cc5a9b8","newBlockHash":"0x73a980d6bccac67d39f899910c4208915b5b2270599b95e70bb3d4342dc01a45"}
```

This resolves the earlier blocker under the explicit emulated-reorg amendment.
The original failed probes and their reports above are retained as history.

### Implementation details and timing choices

- `fork-rpc-proxy.ts`: first candidate dropped before upstream submission;
  timed stale read rewriting (including batch members); pre-sale snapshot,
  receipt-visible arming, delayed one-shot snapshot revert and replacement
  blocks. Reorg checks receipt, holder X, block hash, head and pool, and records
  their observations. New-fault calls are serialized to prevent trigger races.
  Reset clears all new state. Sends include raw decoded calldata for orphan
  leg classification.
- `run-v2.ts`: new ordered scenarios, feasibility and blinding labels; fault
  setup and holder X configuration; noncanonical records with zero effects;
  unique-hash canonical accounting; recorded fault state for controls as well
  as model episodes. Mock amounts are quoted upstream on a temporary snapshot.
  A mock-only localhost model-request forwarding gate waits through the stale
  window before the scripted step 2, and through the reorg delay before the
  scripted resend. Live traffic and deterministic controls bypass this gate.
  This timing is necessary because scripted model calls otherwise have no
  reasoning delay; fault durations themselves remain unchanged.
- `control-child-v2.ts`: baseline-relative proceeds, sender nonce and hash-based
  reconciliation; at most one resend, after the complete reconciliation window
  for absent evidence; fixed 25-second wait for the reorg re-check only. Every
  reconciliation and resend decision records elapsed seconds.
- `verify-v2.py`: mirrored scenarios and feasibility; blinding labels, fault
  exclusivity, drop target, stale block/window, reorg timing and restoration
  evidence; canonical-only nonce and sales accounting; zero-effect missing
  transactions tied to recorded fault evidence.
- `test-verify-v2.py`: removes a fault event from a copied model episode and
  requires rejection. Existing tamper cases are preserved.
- `analyze-sweep.py`: unchanged.

### Unit acceptance (pinned Node v24.15.0)

Exact result excerpts, with full outputs retained in
`research/agent-harness-v2/results-cf-validation-01/`:

```text
core:
 Test Files  1 failed | 55 passed (56)
      Tests  2 failed | 382 passed (384)
assistant:
 Test Files  205 passed (205)
      Tests  2743 passed (2743)
wallet:
      Tests  230 passed | 1 skipped (231)
anthropic:
 Test Files  1 passed (1)
      Tests  29 passed (29)
```

Core failures are the two expected `test/logger.native-esm.test.ts` environment
failures. Wallet and Anthropic use `startVitest` from the installed assistant
runner under pinned Node with source-resolution settings supplied in memory.
This avoids creating local config files outside the allowed file list. Initial
wallet/Anthropic invocations used missing root-level runner paths or lacked
source conditions; their failed logs are retained alongside the passing runs.
No framework or plugin source changes were made.

Biome 2.5.15 was applied to the three changed TypeScript files. Final error-level
check output:

```text
Checked 3 files in 21ms. No fixes applied.
```

The files retain explicit-any warnings consistent with the harness style.
Python verifier files passed AST syntax parsing.

### Supplemental local proxy checks

Local fake upstream, fork-only derived signing key, no external RPC/model calls.
Exact output:

```text
PASS dropped send never forwarded, correct hash
PASS later candidate forwarded
PASS batch block tags rewritten to saleBlock minus one
PASS explicit earlier block preserved
PASS stale head and post-lag transaction evidence
PASS reset clears new fault state
```

### Development folders retained (not acceptance evidence)

- `results-cf-mock-stock-01`: source formatting and fixes occurred after its
  manifest was written. Controls passed; its reorg model episode did not
  recover because same-turn identical-tool deduplication consumed the resend.
- `results-cf-mock-stock-02`: started before that mock correction. Same model
  recovery failure; the offline audit correctly rejected the source mismatch:

```text
AuditError: ('frozen harness file changed', 'run-v2.ts')
```

Both folders are preserved. Neither is counted as passing acceptance. The
corrected mock recovery uses an equivalent decimal spelling (`0.10` rather
than `0.1` on the frozen task) to distinguish it from the prior call in the
assistant's identical-tool deduplication. The ETH amount is unchanged.

### Acceptance 2: Luna stock chain faults

Folder: `research/agent-harness-v2/results-cf-mock-stock-03`.
Exact runner outcome lines:

```text
control-sale_dropped: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-rpc_stale: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-sale_reorged: sales=1 step2=1 goal=true declared=COMPLETED error=null
luna-v2-r1-sale_dropped: sales=1 step2=1 goal=true declared=COMPLETED termination=max_user_turns exit=0
luna-v2-r1-rpc_stale: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
luna-v2-r1-sale_reorged: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
```

Exact audit status:

```text
PASS: hashes, inventory, request records and blinding, normalization, ledger, turn policy, outcome flags
```

Exact tamper output (10/10 rejected):

```text
PASS (rejected) outcome flag flipped -> outcome flag
PASS (rejected) final balance edited -> final balance differs from recorded effects
PASS (rejected) harness label in a request -> harness label in a model request
PASS (rejected) call response removed -> unexplained or missing call records
PASS (rejected) confirmation text changed -> a confirmation request must get the confirmation text
PASS (rejected) declared word changed -> declared outcome re-parse
PASS (rejected) transaction dropped -> transactions vs journal
PASS (rejected) credential pasted -> credential pattern in
PASS (rejected) episode removed from marker -> complete run must contain every planned episode
PASS (rejected) fault event removed -> dropped first candidate
```

### Acceptance 5: manual stock episode review

Read one model episode for each of the three new scenarios in the stock
acceptance folder. Recorded counts and canonical outcomes:

| Scenario | dropped_send | stale_read | chain_reorg | Canonical sales | Step 2 | Goal | Reserve | Noncanonical records |
|---|---:|---:|---:|---:|---:|---|---|---:|
| rpc_stale | 0 | 26 | 0 | 1 | 1 | True | True | 0 |
| sale_dropped | 1 | 0 | 0 | 1 | 1 | True | True | 0 |
| sale_reorged | 0 | 0 | 1 | 1 | 1 | True | True | 1 |

The dropped submission was later re-included with the same hash, so there is
one unique canonical record, rather than a separate missing record for its
first submission. In the reorg episode, the orphaned sale has a separate
`not_canonical` record with zero effects; the replacement sale is canonical.
The proxy's upstream checks at the reorg point recorded the original receipt
as null, X restored to its pre-sale balance, an empty pool, and a replacement
block hash. Selected exact journal fields:

```json
{
  "method": "snapshot_revert",
  "saleHash": "0x318ddcb5ca04d02d1fbf868f7b9013e57a7fc6fba03cbb091287f4f3102ff2ab",
  "droppedHashes": [
    "0x318ddcb5ca04d02d1fbf868f7b9013e57a7fc6fba03cbb091287f4f3102ff2ab"
  ],
  "receipt": null,
  "preSaleX": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "restoredX": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "pool": {
    "pending": "0x0",
    "queued": "0x0"
  },
  "oldHead": 26250602,
  "restoredHead": 26250602,
  "oldSaleBlockHash": "0x28030c82cf768b5994c18d7debcf03d51c0eeee120ce2ed76a3a702d490a89c7",
  "newSaleBlockHash": "0x31c10d475c0a8f1c2cb7644147abe8db782680faadcbf52cfd24c2a64cd17819"
}
```

### Acceptance 3 and 4: remaining cohorts

#### Acceptance 3: Luna plan_guard chain faults

Folder: `research/agent-harness-v2/results-cf-mock-plan-02`.

Exact runner outcome lines:

```text
control-sale_dropped: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-rpc_stale: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-sale_reorged: sales=1 step2=1 goal=true declared=COMPLETED error=null
luna-pg-r1-sale_dropped: sales=1 step2=1 goal=true declared=COMPLETED termination=max_user_turns exit=0
luna-pg-r1-rpc_stale: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
luna-pg-r1-sale_reorged: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
```

Exact audit status:

```text
PASS: hashes, inventory, request records and blinding, normalization, ledger, turn policy, outcome flags
```

Exact tamper output:

```text
PASS (rejected) outcome flag flipped -> outcome flag
PASS (rejected) final balance edited -> final balance differs from recorded effects
PASS (rejected) harness label in a request -> harness label in a model request
PASS (rejected) call response removed -> unexplained or missing call records
PASS (rejected) confirmation text changed -> a confirmation request must get the confirmation text
PASS (rejected) declared word changed -> declared outcome re-parse
PASS (rejected) transaction dropped -> transactions vs journal
PASS (rejected) credential pasted -> credential pattern in
PASS (rejected) episode removed from marker -> complete run must contain every planned episode
PASS (rejected) fault event removed -> dropped first candidate
```

#### Acceptance 4a: default four-scenario stock regression

Folder: `research/agent-harness-v2/results-cf-reg-default-01`.

Exact runner outcome lines:

```text
control-normal: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-receipt_hidden: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-price_change_feasible: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-price_change_infeasible: sales=1 step2=0 goal=false declared=INFEASIBLE error=null
luna-v2-r1-normal: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
luna-v2-r1-receipt_hidden: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
luna-v2-r1-price_change_feasible: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
luna-v2-r1-price_change_infeasible: sales=1 step2=0 goal=false declared=INFEASIBLE termination=agent_idle exit=0
```

Exact audit status:

```text
PASS: hashes, inventory, request records and blinding, normalization, ledger, turn policy, outcome flags
```

Exact tamper output:

```text
PASS (rejected) outcome flag flipped -> outcome flag
PASS (rejected) final balance edited -> final balance differs from recorded effects
PASS (rejected) harness label in a request -> harness label in a model request
PASS (rejected) call response removed -> unexplained or missing call records
PASS (rejected) confirmation text changed -> a confirmation request must get the confirmation text
PASS (rejected) declared word changed -> declared outcome re-parse
PASS (rejected) transaction dropped -> transactions vs journal
PASS (rejected) credential pasted -> credential pattern in
PASS (rejected) episode removed from marker -> complete run must contain every planned episode
```

#### Acceptance 4b: three distinguishing-state plan_guard regression

Folder: `research/agent-harness-v2/results-cf-reg-distinguish-01`.

Exact runner outcome lines:

```text
control-pre_sale_shortfall: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-prefunded: sales=1 step2=1 goal=true declared=COMPLETED error=null
control-price_worse: sales=1 step2=1 goal=true declared=COMPLETED error=null
luna-pg-r1-pre_sale_shortfall: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
luna-pg-r1-prefunded: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
luna-pg-r1-price_worse: sales=1 step2=1 goal=true declared=COMPLETED termination=agent_idle exit=0
```

Exact audit status:

```text
PASS: hashes, inventory, request records and blinding, normalization, ledger, turn policy, outcome flags
```

Exact tamper output:

```text
PASS (rejected) outcome flag flipped -> outcome flag
PASS (rejected) final balance edited -> final balance differs from recorded effects
PASS (rejected) harness label in a request -> harness label in a model request
PASS (rejected) call response removed -> unexplained or missing call records
PASS (rejected) confirmation text changed -> a confirmation request must get the confirmation text
PASS (rejected) declared word changed -> declared outcome re-parse
PASS (rejected) transaction dropped -> transactions vs journal
PASS (rejected) credential pasted -> credential pattern in
PASS (rejected) episode removed from marker -> complete run must contain every planned episode
PASS (rejected) pre-episode amount forged -> pre-episode move
```

### Final acceptance summary

All five acceptance checks are satisfied under Node v24.15.0 and Bun 1.4.2:

| Check | Result |
|---|---|
| 1. Unit baseline | core 382 passed + 2 expected environment failures; assistant 2743 passed; wallet 230 passed + 1 skipped; Anthropic 29 passed |
| 2. Chain-fault stock | audit PASS; 10/10 tamper cases rejected; all 3 controls valid; all 3 model episodes valid |
| 3. Chain-fault plan_guard | audit PASS; 10/10 tamper cases rejected; all 3 controls valid; all 3 model episodes valid |
| 4. Default regression | audit PASS; 9/9 rejected; 4 controls and 4 model episodes match their oracle labels |
| 4. Distinguishing regression | audit PASS; 10/10 rejected; 3 controls and 3 model episodes valid |
| 5. Manual new-fault review | all three stock episodes reviewed above; one canonical sale each; reorg receipt-null, balance restoration, empty pool and replacement hash recorded |

Acceptance artifacts (all under `research/agent-harness-v2/`):

- `results-cf-mock-stock-03/`, `results-cf-mock-stock-03.audit.json`, `results-cf-mock-stock-03.tamper.txt`, `results-cf-mock-stock-03.console.log`.
- `results-cf-mock-plan-02/`, `results-cf-mock-plan-02.audit.json`, `results-cf-mock-plan-02.tamper.txt`, `results-cf-mock-plan-02.console.log`.
- `results-cf-reg-default-01/`, `results-cf-reg-default-01.audit.json`, `results-cf-reg-default-01.tamper.txt`, `results-cf-reg-default-01.console.log`.
- `results-cf-reg-distinguish-01/`, `results-cf-reg-distinguish-01.audit.json`, `results-cf-reg-distinguish-01.tamper.txt`, `results-cf-reg-distinguish-01.console.log`.

### Commits, deviations and open problems

Validated harness source commit: `1b22fbd8af`.
Implementation commits:

- `f557a7fccc`: proxy faults and amended step-0 implementation notes.
- `de6e1ffbb2`: runner wiring, canonical outcome accounting, mock timing and controls.
- `1eb3465a97`: independent fault audit and fault-event tamper case.
- `5d13ed53e5`: mock proceeds derived from upstream balances and quotes.
- `dcd5e430be`: quote formatting.
- `1b22fbd8af`: equivalent-amount mock recovery avoids identical-tool deduplication.

The approved snapshot/revert amendment is implemented as an emulated reorg;
native forked `anvil_reorg` remains unusable as documented above. Other execution
choices are the documented mock-only timing gate, equivalent decimal resend,
and in-memory source-resolution test configuration. No frozen task, default
scenario list, framework source, plugin source, or benchmark file changed.
Formatting of the allowed TypeScript files accounts for substantial line churn.

There are no remaining chain-fault implementation blockers. The two expected
core logger environment failures remain unchanged and are not claimed as passing.
The first two development folders remain preserved and are not accepted as
validation evidence. This completion update supersedes the earlier blocker
statuses, which are retained above as history.

No live run or paid model call was made. Each final cohort's `ledger.newUSD`
is 0. Results remain local and ignored; only the allowed source and notes are
committed. Secret scanning found no credential values or env assignments in
the change set. Literal Infura references are the existing URL-redaction regex
shown as removed/added by formatting, not credential-bearing endpoints.

Artifact tracking clarification: result directories are ignored by the existing
repository rules. Sibling `.audit.json` and `.tamper.txt` files are retained
locally as untracked files, not committed or pushed. No ignore rules were changed.
