# Research: containing transacting agents

Which irreversible effects can a multi-step DeFi agent admit under confirmation gates, existing on-chain controls, and sequence-level plan enforcement? We use a pinned mainnet fork, controlled faults and chain-state scoring to measure containment, including unsafe effects admitted and legitimate steps refused.

Start with [OVERVIEW.md](OVERVIEW.md), then the [framework change map](notes/framework-changes.md) and [current backlog](notes/hardening-backlog.md). This is a research branch of `umututku03/eliza`; no upstream PR is open.

| Directory | Purpose |
|---|---|
| [agent-harness-v2/](agent-harness-v2/) | Driver, isolated agent processes, model/chain proxies, budget ledger, independent verifier and tamper checks. |
| [benchmark/](benchmark/) | Draft pre-registration, calibrated D1/H1–H3 tasks, the deterministic control suite, the compromised-agent matrix and the plan-authoring probe. |
| [paper/](paper/) | Paper draft (IEEE conference format) and bibliography. |
| [plan-guard/](plan-guard/) | Plan-step and absolute-balance-floor enforcers, compiled locally and tested on the fork. |
| [notes/](notes/README.md) | Findings, live-check records, related work, current plans and historical reports. |

## Reproduce

Run commands from the repository root in bash. Use **Node 24.15.0 and Bun 1.4.2** locally. Do not replace global versions. For macOS Apple Silicon, one installation is:

```bash
TOOLS_DIR="$HOME/tools/eliza-research"
mkdir -p "$TOOLS_DIR/node24150" "$TOOLS_DIR/bun142"
npm install --prefix "$TOOLS_DIR/node24150" --no-save node@24.15.0
npm install --prefix "$TOOLS_DIR/bun142" --no-save --ignore-scripts @oven/bun-darwin-aarch64@1.4.2
export PATH="$TOOLS_DIR/node24150/node_modules/node/bin:$TOOLS_DIR/bun142/node_modules/@oven/bun-darwin-aarch64/bin:$PATH"
node --version  # v24.15.0
bun --version   # 1.4.2
bun install --frozen-lockfile --ignore-scripts \
  --filter @elizaos/core --filter @elizaos/plugin-assistant --filter @elizaos/plugin-sql \
  --filter @elizaos/plugin-openai --filter @elizaos/plugin-anthropic --filter @elizaos/plugin-wallet
bun packages/scripts/ensure-workspace-symlinks.ts
(cd research/plan-guard && bun install --frozen-lockfile && bun compile.ts)
(cd research/agent-harness-v2 && bun install --frozen-lockfile)
```

Other platforms need the matching pinned Bun binary. Set these shell variables yourself; never commit or display their values:

- `FORK_ENV`: external env file containing `MAINNET_FORK_RPC_URL`.
- `KEYS_ENV`: external provider-key env file, used only for separately approved live calls.
- `ANVIL_BIN`: local Anvil executable. Use fork-only test accounts.

The following checks use no model-provider keys. Keep every result directory. Choose a fresh output directory:

```bash
mkdir -p test-results/research-reproduce
RESEARCH_OUT=$(mktemp -d "$PWD/test-results/research-reproduce/run-XXXXXX")
```

### Unit suites

Wallet tests need this local-only source-resolution config; keep it excluded from git:

```bash
cat > plugins/plugin-wallet/vitest.source.local.config.ts <<'CONFIG'
import { mergeConfig } from "vitest/config";
import base from "./vitest.config";
export default mergeConfig(base, {
  resolve: { conditions: ["eliza-source"] },
  ssr: { resolve: { conditions: ["eliza-source"], externalConditions: ["eliza-source"] } },
});
CONFIG
printf '%s\n' 'plugins/plugin-wallet/vitest.source.local.config.ts' >> "$(git rev-parse --git-path info/exclude)"
(cd packages/core && node ../../plugins/plugin-assistant/node_modules/.bin/vitest run)
(cd plugins/plugin-assistant && node ./node_modules/.bin/vitest run)
(cd plugins/plugin-wallet && node ./node_modules/.bin/vitest run --config ./vitest.source.local.config.ts)
```

The recorded partial-build baseline has two known `logger.native-esm` core environment failures. Exact before/after counts and their scope are in the [cleanup report](notes/codex-report-livecheck2-final-and-cleanup.md).

### Fork route and enforcers

```bash
set -o pipefail
ANVIL_BIN="$ANVIL_BIN" bun --conditions=eliza-source --env-file="$FORK_ENV" \
  research/agent-harness-v2/control-v2-route.ts 2>&1 | grep -v -i "alchemy\|https://"
ANVIL_BIN="$ANVIL_BIN" bun --conditions=eliza-source --env-file="$FORK_ENV" \
  research/plan-guard/fork-test.ts --out="$RESEARCH_OUT/plan-guard.json" \
  2>&1 | grep -v -i "alchemy\|https://"
```

### Deterministic controls suite

This example reproduces one task/state/condition cell. The complete matrix uses tasks D1/H1/H2/H3, states calibrated/shortfall/prefunded, and conditions stock_fixed/existing_controls/plan_guard; see [suite-v1-summary.md](benchmark/suite-v1-summary.md).

```bash
ANVIL_BIN="$ANVIL_BIN" bun --conditions=eliza-source --env-file="$FORK_ENV" \
  research/benchmark/control-suite.ts --tasks=research/benchmark/tasks.json \
  --task=H1 --condition=plan_guard --state=shortfall --out="$RESEARCH_OUT/control-H1.json" \
  2>&1 | grep -v -i "alchemy\|https://"
```

### Compromised-agent matrix

No model and no ElizaOS runtime. It uses its own Anvil port (default 18745), so it can run beside a live cohort.

```bash
ANVIL_BIN="$ANVIL_BIN" bun --env-file="$FORK_ENV" research/benchmark/compromised-agent-matrix.ts \
  --tasks=research/benchmark/tasks.json --task=D1 --out="$RESEARCH_OUT/compromised-D1.json" \
  2>&1 | grep -v -i "alchemy\|https://"
python3 -I research/benchmark/summarize-matrix.py "$RESEARCH_OUT"/compromised-D1.json
```

### One mock cell, audit and tamper checks

```bash
ANVIL_BIN="$ANVIL_BIN" bun --conditions=eliza-source --env-file="$FORK_ENV" \
  research/agent-harness-v2/run-v2.ts --mode=mock --models=luna,haiku --reps=1 \
  --condition=stock --dest="$RESEARCH_OUT/mock-D1-stock" \
  2>&1 | grep -v -i "alchemy\|https://"
python3 -I research/agent-harness-v2/verify-v2.py "$RESEARCH_OUT/mock-D1-stock"
python3 -I research/agent-harness-v2/test-verify-v2.py "$RESEARCH_OUT/mock-D1-stock"
```

Mock responses are scripted. They test execution, recording and auditing, not model reliability. For another task use `--task=H1`; for another control condition use `--condition=existing_controls` or `--condition=plan_guard`.

## Results and scope

- Committed summaries:
  - [control suite](benchmark/suite-v1-summary.md);
  - [compromised-agent matrix](benchmark/matrix-v2-summary.md);
  - [plan-authoring probe](benchmark/plan-authoring-summary.md);
  - [enforcer fork cases](plan-guard/fork-test-results.json).
- Live cohorts are summarised with `python3 -I research/agent-harness-v2/analyze-sweep.py <results dirs> --md`.
- [Live check 2](notes/live-check-2-2026-10-26.md) contains both live-check tables, exact spend, source commits and unresolved L6/L7. All live runs so far are development checks.
- Small `results-livecheck*.audit.json` summaries are committed under `agent-harness-v2/`. Raw directories, console logs and dryrun audit sidecars stay local and ignored; the local run archive retains their checksums. No raw traces are published here.
- Audits bind exact source/harness hashes. Re-audit historical raw data with its producing source version; formatting changes also change hashes. Current-code reproduction uses a new output folder.
- The [pre-registration](benchmark/PREREGISTRATION.md) remains a draft. The current mechanism and live checks do not establish production safety or agent reliability.
