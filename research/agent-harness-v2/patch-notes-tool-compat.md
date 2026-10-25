# Local integration patch after live cohort 1c

Base: `3635d598fe`. Patch branch: `fix/v2-tool-call-compat`.

Two failures observed in the saved live traces are addressed:

1. The OpenAI plugin ignored `OPENAI_REASONING_EFFORT=none`. For the exact
   OpenAI model IDs `gpt-6-luna` and `gpt-6-sol`, a nonempty Chat Completions
   tool request now defaults to `none`. Explicit caller/operator effort
   settings retain precedence. Runtime and environment `none` settings are
   forwarded. See the plugin's `docs/gpt6-tool-calling.md` for the endpoint
   restriction and its explicit-setting caveat.
2. Discovery rejected requests such as
   `{"mode":"load","names":[],"query":"wallet balances","contexts":null}`.
   The handler now treats optional null selectors as absent and ignores an
   empty names list when searching. Nonempty exact names still conflict with
   query/context selectors. Invalid empty contexts remain rejected, unknown
   contexts remain restrictive, and current permission admission still applies.

The OpenAI test config now uses the existing workspace source-alias helper,
allowing tests to resolve unbuilt internal packages in a fresh checkout.

Regression tests use local fixtures and saved request shapes. They verify the
outbound SDK request, streaming and returned function calls, explicit-setting
precedence, discovery loading, permission revocation, and read-only discovery.
Validation: 116 provider tests and 206 discovery/planner tests passed (322 total).
Both plugin source typechecks passed with `--customConditions eliza-source`;
the ordinary typecheck expects built workspace declaration files. Formatting,
lint checks on changed runtime/test files, and `git diff --check` passed.

From the corresponding plugin directory, provider tests use:

```sh
bun --conditions=eliza-source ./node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts \
  __tests__/gpt6-tool-reasoning.wire.test.ts \
  __tests__/qwen-response-schema.wire.test.ts \
  __tests__/openrouter-fallback.wire.test.ts \
  __tests__/fallback-model.wire.test.ts \
  __tests__/wire-well-formed.shape.test.ts
```

Discovery checks, from `plugins/plugin-assistant`:

```sh
bun --conditions=eliza-source ../plugin-openai/node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts \
  src/services/message/tool-discovery.nullable-selectors.test.ts \
  src/services/message/tool-discovery.test.ts \
  src/services/message/tool-discovery.planner.test.ts \
  src/services/message/contextual-discovery.test.ts
```

These fixes do not establish that the agent can complete the two-trade task.
They do not add missing external data services or alter wallet execution,
confirmation, plan enforcement, or financial permissions.

No paid experiments were run for this patch. Prior results, reports, and frozen
harness files remain unchanged. This local patch has not been pushed, and no
GitHub issue or PR has been filed.
