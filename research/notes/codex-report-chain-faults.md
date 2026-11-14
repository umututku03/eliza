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
