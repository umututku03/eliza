# GPT-6 Chat Completions tool compatibility

The text adapter uses Chat Completions. OpenAI documents that `gpt-6-luna`
and `gpt-6-sol` support function tools on that endpoint only with
`reasoning_effort: "none"`:

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)

For those exact model IDs, the adapter defaults nonempty tool requests to
`none` when the caller/operator has not selected an effort. Text-only calls
retain the provider default. An explicit `OPENAI_REASONING_EFFORT=none` is
forwarded from runtime settings or the environment, including text-only calls.

Explicit caller `providerOptions.openai.reasoningEffort` values take precedence
over runtime settings and defaults. An explicit non-`none` effort on a tool
request is preserved and remains incompatible with this endpoint; use a
Responses integration for reasoning with tools. This patch does not add a
Responses transport or change other models' compatibility contracts. In
particular, it does not apply this default to `gpt-6-astra`, `gpt-6.1-sol`,
Cerebras, EvoLink, or OpenRouter fallback routes.

The tests capture actual AI SDK serialization against a loopback fixture:

```sh
cd plugins/plugin-openai
bun --conditions=eliza-source ./node_modules/vitest/vitest.mjs run \
  --config vitest.config.ts __tests__/gpt6-tool-reasoning.wire.test.ts
```

The plugin test config uses the repository's workspace source aliases so a
fresh checkout can resolve internal packages without building all workspaces.
The tests make no external provider requests. Passing these tests establishes
request compatibility, not end-to-end agent task completion. Existing research
results and their frozen harness are unchanged.
