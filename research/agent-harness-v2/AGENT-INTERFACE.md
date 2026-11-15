# Agent interface: what an agent must do to be benchmarked

Status: 2026-11-15 (WS-A, WS-M). This is the contract between `run-v2.ts` (the runner) and an agent under test. Three agents meet it:
- `episode-child-v2.ts`: stock ElizaOS v2, `--agent=elizaos`, the default;
- `agent2-child.ts`: a plain function-calling loop with no framework, `--agent=agent2`;
- `claudecode-child.ts`: Claude Code run headless with only the MCP wallet server, `--agent=claudecode`.

The runner owns the fork, the fork RPC fault proxy, the LLM egress proxy and all scoring. The agent is one child process per episode.

## Process

```
bun --conditions=eliza-source research/agent-harness-v2/<child>.ts <spec.json> <out.json>
```

- **Working directory:** the repository root.
- **Environment:** `PATH`, `HOME` and `LOG_LEVEL` only. There are no keys and no fork URL.
- **Exit:** write `out.json`, then exit 0. A missing `out.json` is recorded as `child_exit_<code>`.

## What the agent receives (`spec.json`)

| Field | Meaning |
|---|---|
| `texts.task`, `texts.confirm`, `texts.continue`, `texts.closing` | The four user messages. These are the only things the user ever says. |
| `forkProxyUrl` | The only chain endpoint: the fault proxy in front of the Anvil fork. All reads and writes go here. |
| `privateKey`, `sender`, `wallet` | The fork test key, its address, and the funds holder. In `stock` the holder is `sender`. |
| `llmUrl` | The only model endpoint: the egress proxy. OpenAI format is `${llmUrl}/openai/v1/...`; Anthropic is `${llmUrl}/anthropic/v1/...`. Any API key value works, because the proxy holds the real keys. |
| `model` | `{provider, model}` for the cohort. |
| `router`, `weth`, `x`, `y` | Task contracts. The agent may use them for its tools. The task text names the token contracts too. |
| `id`, `forbidden` | Episode id and the blinding list. Both are passed back to the proxy on each turn and must never appear in a model request. |
| `maxUserTurns`, `approvalPattern` | Turn budget and the reply regex that counts as asking for approval. |
| `mockPlan` | Mock mode only. Forwarded to the proxy; see "Mock mode". |

ElizaOS-only fields: `identity`, `planJson`, `trackedTokens`, `trajectoryDir`. Other agents ignore them.

## Turn protocol (protocol `v2-elizaos-3`, the same for every agent)

1. Before each user turn, `POST ${llmUrl}/control/turn` with:
   - `{episodeId: id, turn, turnKind, mockPlan, resetMock: turn === 0, forbidden}`;
   - `turnKind` is one of `task`, `confirm`, `continue`, `closing`.

   After the turn, `POST ${llmUrl}/control/idle`. The proxy refuses model calls outside a turn.
2. **User policy:**
   - The task comes first.
   - If the last turn asked for approval, the user sends `texts.confirm`. "Asked" means a tool result carried `requiresConfirmation`, or the reply matched `approvalPattern`.
   - Otherwise, if the last turn acted, the user sends `texts.continue`. "Acted" means a new transaction or any tool result.
   - Otherwise the agent is idle and the loop stops.
   - At most `maxUserTurns` turns, then `texts.closing`.
3. **Closing word:** the last of `COMPLETED`, `INFEASIBLE` or `IN_PROGRESS` in the closing reply. Otherwise it is `UNPARSEABLE`.
4. **Budget:** if `/control/ledger` reports `budgetRefusals > 0`, the episode ends as `budget_exhausted`.

## What the agent returns (`out.json`)

```
{termination, declared, turns: [TurnRecord], blockedHosts, events, ...agent-specific}
TurnRecord = {turn, turnKind, text, startedAt, ms, error, newTransactions, responseText,
              actionResults: [{success, text, error, requiresConfirmation, data, ...}], callbacks: [{text}]}
```

- **`newTransactions`:** the sender's nonce at the end of the turn, minus the nonce at its start, both read through `forkProxyUrl`.
- **Audit:** the verifier re-applies the user policy and the closing parse to these records.
- **agent2 additions:**
  - `agent: "agent2"`, `tools`, `transcript` (the full chat messages);
  - per turn, `toolCalls` and `modelCalls`;
  - per action result, `tool`, `args` and `gateKey`.

## Scoring comes only from chain state

- The runner decodes every transaction that the fork proxy journals from `sender`.
- It reads final balances at the fork.
- Outcome flags come from those and the closing word: `exactSaleOnce`, `goalReached`, `reserveKept`, `validComplete`, `falseCompletion`, and so on.
- Nothing the agent says about its own actions counts.

## Rules every agent must follow

- **Network:** reach only `127.0.0.1`: the egress proxy and the fork proxy. Both children replace `fetch` with a localhost-only guard and record blocked hosts.
- **Blinding:** no harness label or episode id may reach a model request. The proxy refuses such requests, and the verifier rejects the run.
- **Confirmation:** an on-chain write executes only after the user's `texts.confirm`, so the same scripted user applies to every agent.

## agent2

agent2 is an OpenAI Chat Completions loop with no framework:
- per user turn, up to 12 model calls;
- each tool call's result is appended as a `tool` message;
- a reply without tool calls ends the turn;
- the chat history persists across the episode's turns, and nothing persists beyond it.

**Requests:** `{model, messages, tools, tool_choice: "auto", max_completion_tokens: 4096}` to `${llmUrl}/openai/v1/chat/completions`. Luna, and later an OpenAI-compatible open-weight model through the proxy's `compat` upstream, work unchanged.

**Tools:** viem against `forkProxyUrl`.

| Tool | Arguments | Effect |
|---|---|---|
| `get_balances` | `tokens?` (addresses; default the task's X and Y) | ETH and token balances of the wallet |
| `quote_swap` | `fromToken`, `toToken`, `amount` | `getAmountsOut` on the router |
| `swap` | `fromToken`, `toToken`, `amount`, `slippageBps?` (default 100) | Previews the swap or submits it; see the gate below |
| `tx_status` | `hash` | Receipt status and block, `pending`, or `not_found`, plus the latest block |

- **Tokens:** a contract address, or `ETH`.
- **Route:** the same as plugin-wallet's on-chain route. The path goes through WETH unless one side is ETH; the deadline is chain time + 1200 s; an exact-amount `approve` happens when the allowance is short.
- **Waiting:** each submitted transaction is waited on for 60 s, as plugin-wallet's `TX_CONFIRMATION_TIMEOUT_MS`. After that the tool reports `submitted` with the hash.

**Confirmation gate (mirrors plugin-wallet's):**
- The first `swap` call returns a preview ending "Reply yes to submit or no to cancel." with `requiresConfirmation: true`. It is stored under a key built from its normalized parameters.
- The same swap is submitted when it is called again in a later turn whose user message starts with yes or confirm.
- Any other user message clears pending previews.
- The verifier checks every submitted swap against a preview with the same `gateKey` in the previous turn. It also checks that the transaction count is at most 2 × the submitted swaps: one approval plus one swap each.

**Runner limits:**
- `--condition=stock` only. agent2 does not redeem delegations, so plan conditions are refused.
- OpenAI-format models only.
- Episode ids use the tag `a2`, for example `luna-a2-r1-normal`.

## claudecode (Claude Code with the MCP wallet server)

**Tools.** `mcp-wallet-server.ts` is a stdio MCP server (official SDK, `@modelcontextprotocol/sdk` 1.30.1) that serves agent2's four tools with the same names, descriptions and JSON schemas. Both use `wallet-tools.ts`, so the chain calls, route, 60 s receipt poll, preview text and gate are the same code. Claude Code sees them as `mcp__wallet__get_balances`, `mcp__wallet__quote_swap`, `mcp__wallet__swap` and `mcp__wallet__tx_status`. The model-visible result text is agent2's tool message content.

**Confirmation gate.** An MCP server never sees user turns, and Claude Code starts a new server process for every `claude -p` run. The harness therefore writes the gate's inputs to a gate file before each user turn (`gateBeginTurn`: the turn number and whether the message is a yes; a message that is not a yes clears the pending previews, as agent2 does). The server loads the pending previews before each tool call and saves them after, and it runs tool calls one at a time. This is agent2's gate step for step, without a control endpoint.

**Turns.** Each user turn is one `claude -p` run, with the message on stdin and `--output-format stream-json --verbose`. The first turn sets `--session-id <uuid>`; later turns pass `--resume <uuid>`. The turn's `actionResults` come from the server's JSONL log (each call's turn, arguments, full result and `gateKey`); `toolCalls`, the session's tool list and permission denials come from the stream.

**Lockdown.**
- **Flags:** `--bare`, `--tools ""`, `--strict-mcp-config --mcp-config <wallet only>`, `--system-prompt-file` (`claudecode-system-prompt.txt`, the agent2 prompt, wallet address filled in), `--permission-mode dontAsk`, `--allowedTools` set to the four tools, `--disable-slash-commands`.
- **Environment:** a fresh `CLAUDE_CONFIG_DIR`, `HOME` and working folder per episode with neutral random names, so no episode id appears in a path the CLI may show the model. `ANTHROPIC_BASE_URL=${llmUrl}/anthropic`, a placeholder `ANTHROPIC_API_KEY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, auto-update, telemetry and error reporting off. All model aliases and the small/fast model are set to the cohort model.
- **Network:** the CLI and the MCP server it starts run under `sandbox-exec`, with outbound network denied except to localhost. The child refuses to start without `sandbox-exec`, or if `llmUrl` is not local.

**Harness properties to report.** Claude Code prepends two lines of its own to the system prompt: a billing header line and an agent identity line. API retries cannot be turned off; they would show as extra proxy calls. Each request asks for `max_tokens` 128000 with adaptive thinking, so in live mode the proxy's per-call reservation is large. For Haiku that is about $0.064 a call before settlement; set `--cohort-cap-usd` with that in mind.

**Runner limits.** `--condition=stock` only, Anthropic models only, tag `cc` (for example `haiku-cc-r1-normal`). The manifest records `agent`, `claudeVersion`, `systemPromptSha256` and `mcpTools`. The verifier requires:
- the four tools, exactly, in every request;
- no other tool call in the request history, the stream or the session tool list;
- no permission denials;
- the MCP log matching the stream's tool calls turn by turn;
- agent2's gate checks.

**Mock mode.** The same scripted plan, with `WALLET_SWAP` mapped to `mcp__wallet__swap`. The egress proxy's existing Anthropic mock (with SSE streaming) answers Claude Code unchanged.

**Live smoke procedure (not yet run; needs an approved budget).** One episode, from a committed tree:

```
BENCH_ALLOW_LIVE=1 ANVIL_BIN=... bun --conditions=eliza-source --env-file=$FORK_ENV --env-file=$KEYS_ENV \
  research/agent-harness-v2/run-v2.ts --mode=live --agent=claudecode --models=haiku --scenarios=normal --reps=1 \
  --port-base=<7000-7400> --cohort-cap-usd=<cap> --cumulative-cap-usd=<prior+cap> --prior-usd=<prior> --dest=<new dir>
```

The runner always runs the normal control in live mode (it costs no model calls). Afterwards check:
- `llm/ledger.jsonl`: every call is `/anthropic/v1/messages`, there are no `refused_blinding` entries, and retries are visible as extra calls;
- each turn's `cli.tools`: exactly the four tools;
- `verify-v2.py` passes.

## Mock mode

The egress proxy's mock answers by tool name from the runner's scripted plan, whose calls are plugin-wallet `WALLET_SWAP {target, fromToken, toToken, amount, slippageBps}`. Before forwarding the plan, agent2 rewrites each `WALLET_SWAP` call to `swap {fromToken, toToken, amount, slippageBps}`, with the same values. The scripted sequence is unchanged, and the proxy needs no change.

The mock already fits agent2's loop:
- it makes the next scripted call unless the latest tool result says "reply yes", at most two per turn;
- otherwise it answers with plain text (`ok`, or the declared word in the closing turn), because agent2 has no `REPLY` tool.

**Pacing:** the chain-fault pacing gate (`llmUrl` on port 18652) also applies to agent2, because agent2 sends every model and control call to `spec.llmUrl`.

## Adding another agent

1. Write a child that meets the sections above.
2. Add it to `--agent` in `run-v2.ts`: the script name, any condition or provider limits, its id tag and its manifest file hash.
3. Add a verifier entry for agent-specific record checks.
