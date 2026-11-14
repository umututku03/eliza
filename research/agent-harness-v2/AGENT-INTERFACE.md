# Agent interface: what an agent must do to be benchmarked

Status: 2026-11-14 (WS-A). This is the contract between `run-v2.ts` (the runner) and an agent under test. Two agents meet it:
- `episode-child-v2.ts`: stock ElizaOS v2, `--agent=elizaos`, the default;
- `agent2-child.ts`: a plain function-calling loop with no framework, `--agent=agent2`.

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
