# WS-A report: framework-agnostic adapter and a second agent (14 November 2026)

Status: 2026-11-14.
- **Written by:** the WS-A subagent. The harness blocked it from writing this file, so the coordinator committed its returned text.
- **Branch:** `ws/agent2`. Final implementation commit: `7793ad4f99`.
- **Cost:** mock only, $0 (every audit has `liveUSD` 0.0).
- **Audit files:** the local path prefix was stripped afterwards.

## Commits
| Commit | Change |
|---|---|
| `e37b90e12d` | agent2 child |
| `9fbc15e4c7` | run-v2 `--agent` flag |
| `5527e52646` | verifier and tamper entries |
| `ecdcb519c9` | AGENT-INTERFACE.md |
| `4a239b47ed` | agent2 polls for receipts instead of viem's waiter |
| `7793ad4f99` | acceptance audit JSONs |

## Acceptance (re-verified by the coordinator)
| Item | Result |
|---|---|
| agent2, D1, stock, default four scenarios (`results-wsa-agent2-default4-02`) | audit PASS; tamper 10/10 rejected (9 + a new agent2 case); controls 4/4 valid |
| agent2, three new chain faults (`results-wsa-agent2-faults-02`) | audit PASS; tamper 11/11 rejected; controls 3/3 valid |
| ElizaOS regression, default `--agent` (`results-wsa-eliza-reg-default4-01`) | audit PASS; tamper 9/9; runner lines identical to chain-faults acceptance 4a; the manifest has no `agent` key and the same 10 files |

**agent2 runner lines.**
- **Default four:** normal, receipt_hidden and price_change_feasible each end sales=1, step2=1, goal true, COMPLETED. price_change_infeasible ends sales=1, step2=0, INFEASIBLE.
- **Chain faults:** sale_dropped, rpc_stale and sale_reorged each end sales=1, step2=1, goal true, COMPLETED.
- **Model calls:** 33 per agent2 run, against 89 for ElizaOS on the default four.

**Episode reads.**
- **sale_dropped:** one `dropped_send`. The sale reported `submitted` after the 60 s poll; the retry succeeded; one canonical sale.
- **rpc_stale:** 60 `stale_read` events; one confirm turn took about 200 s.
- **sale_reorged:** one `chain_reorg` (depth 1, receipt null, X restored to 0). The first sale is `not_canonical`; the retry succeeded; `exactSaleOnce` is true.
- **Network:** `blockedHosts` is empty everywhere.

## Changes
- **`agent2-child.ts` (new):** a plain OpenAI Chat Completions function-calling loop with no framework.
  - **Contract:** the same as `episode-child-v2.ts`: `/control/turn` and `/control/idle`, user policy v2-elizaos-3, closing-word parse, budget stop, localhost-only fetch guard, record shape.
  - **Tools:** `get_balances`, `quote_swap`, `swap`, `tx_status`, via viem against `spec.forkProxyUrl` only.
  - **Swap route:** copies plugin-wallet's Uniswap V2 route (path through WETH, deadline = chain time + 1200 s, exact-amount approve, 60 s receipt poll).
  - **Confirmation gate:** previews first and submits only on the next "yes".
  - **Model traffic:** only to `${spec.llmUrl}/openai/v1/chat/completions`.
  - **Mock mode:** maps the scripted `WALLET_SWAP` calls to `swap`; the egress proxy is unchanged.
- **`run-v2.ts`:** `--agent=elizaos|agent2`. agent2 is limited to stock and OpenAI-format models. It uses ID tag `a2`, adds the child to the hashed files, and records `manifest.agent` and deviations. The default path is unchanged.
- **`verify-v2.py`:** new agent2 checks.
  - The agent type is known, the run is stock with OpenAI models, and the child is hashed; the tag is `a2`.
  - Every request goes to `/openai/v1/chat/completions` with exactly the four tools; only `swap` asks for confirmation.
  - Every submitted swap has a preview with the same key in the previous confirm turn; at most 2 transactions per submitted swap.
- **`test-verify-v2.py`:** a new case, "agent2 swap without confirmed preview", for agent2 folders only.
- **`AGENT-INTERFACE.md` (new):** the contract any agent must meet.
  - **Inputs:** task and turn texts, RPC URL (the fault proxy), key, LLM base URL (the egress proxy), model, blinding list.
  - **Outputs:** per-turn reply, tool calls and results, then the one-word verdict.
  - **Scoring:** from chain state only.

## How comparable agent2 is to ElizaOS
- **Tools:** ElizaOS runs a large multi-chain WALLET router behind a two-stage planner and injects wallet context into the prompt. agent2 has four narrow tools and a one-line system prompt. Its explicit `tx_status` may make chain evidence easier to reach.
- **Confirmation:** both gates key the pending swap by its parameters and submit only on a later "yes". agent2 also cancels pending previews on any message that isn't a yes, and treats `0.1` and `0.10` as the same amount.
- **Memory:** ElizaOS keeps room memories, evaluators and fact extraction. agent2 has only the episode's chat history.
- **Model traffic:** agent2 makes 33 calls against 89, and none outside a turn (ElizaOS makes 4). agent2 cannot run Anthropic models.
- **Receipt waiting (important):** in `receipt_hidden`, ElizaOS's swap reports failure **199 ms** into the confirm turn ("Transaction receipt … could not be found"). viem's `waitForTransactionReceipt` throws when a mined transaction's receipt is missing, which contradicts `protocol.md`'s statement that v2 waits 60 s. agent2 polls for the full 60 s and reports `submitted`. The two agents therefore see different first evidence.

## Kept development folders (none deleted)
- `results-wsa-agent2-default4-01`: superseded; it used viem's waiter and reproduced ElizaOS's immediate failure, which led to the poll fix.
- `results-wsa-agent2-faults-01`: partial; stopped on purpose after the fix.
- `results-wsa-smoke1`: a one-episode smoke run with `--skip-controls`; not auditable by design.

## Decisions for the coordinator
1. **`receipt_hidden` behaviour:** keep agent2's 60 s poll or match ElizaOS's immediate throw. Either way, correct `protocol.md` to describe what ElizaOS actually does.
2. **Tamper thresholds:** agent2 folders have one extra case (10 for the default four, 11 with chain faults).
3. **Open-weight model:** agent2 needs only MODELS and PRICES entries for the compat upstream; its tool-calling quality is untested.
4. **Merging with ws/benchmark:** small conflicts expected. agent2 uses only `spec.llmUrl` and `spec.forkProxyUrl`, so `--port-base` needs no agent2 change.
