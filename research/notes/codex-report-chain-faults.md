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
