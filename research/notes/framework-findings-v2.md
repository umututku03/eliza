# Framework findings: stock ElizaOS v2 on a two-step DeFi task (pinned mainnet fork)

October 2026. Every item comes from saved live traces or a fork check. The commit names where it was fixed in our fork. None has been reported upstream: under elizaOS `AGENTS.md`, agents must not file issues, so the user decides and writes them by hand.

**Setup:**
- task D1 (sell 0.1 ETH for USDC, then hold ≥ 37.31 DAI keeping ≥ 178.23 USDC);
- block 26250601;
- `gpt-6-luna` and `claude-haiku-5-5`.

The results folders are git-ignored and stay local; each passed `verify-v2.py` at its own commit.

## A. Defects that stopped agents before the task's second step

| # | Component | Defect | Effect seen | Evidence | Fixed in |
|---|---|---|---|---|---|
| A1 | plugin-openai | Chat Completions tool requests for `gpt-6-luna` carry no `reasoning_effort: "none"`. OpenAI rejects function tools with any other effort on that endpoint, and the plugin never sends "none" to OpenAI. | Every planner call returned HTTP 400. The agent did nothing and said "something went wrong… please retry". It labelled the permanent error *transient*. | live-1b run 1: 16/16 tool requests 400, 0 transactions in 8 episodes | `f2c9139707` (Codex) |
| A2 | plugin-assistant tool discovery | A discovery call with null optional selectors, or an empty `names` list alongside a query, was refused: "Use query and/or contexts, or exact names, not both. No tools were loaded." | The planner could not load the wallet tools. 62 refusals across the Luna cohorts. | live-1c | `f2c9139707` (Codex) |
| A3 | plugin-assistant financial-completion check | A successful submission reported by a promoted action (`WALLET_SWAP`) was not accepted as evidence; only `actionName === "WALLET"` was. | After a real sale, the reply failed with "A grounded conversational reply could not be generated" and the turn ended. 10 of 32 live-1c episodes. | live-1c; Codex normal-task check | `0e2d0d05bf` (Codex) |
| A4 | plugin-wallet | `mode: "simulate"` was unsupported for EVM swaps, and token info and prices need external services. | The agent could not price step 2: "The token lookup failed… so I couldn't determine whether a trade can meet the DAI target." | live-1c (Luna) | `d33bb501a8`: simulate returns the route's quote (expected and minimum output); a fork check matches the executed output exactly |
| A5 | plugin-wallet | The wallet context listed only native balances; token balances resolve symbols through an external API. | "I can't confirm… the wallet and market-data checks were unavailable." | dev run 1, plan_guard Luna | `fe88ecf023`: `EVM_WALLET_TRACKED_TOKENS`, read on-chain |
| A6 | plugin-wallet | The wallet cache refreshes every 60 s and is not invalidated after the wallet's own transaction. | Right after selling 0.1 ETH, the context still said "Ethereum: 1 ETH". | fork check (`control-v2-route.ts`) | `5b47b508ed`: refresh after a successful swap or transfer |

| A7 | plugin-wallet | The EVM balance provider and plugin-wallet's top-level address-only provider are both named `"wallet"`. The runtime keeps the first and skips the second, logging only a collision warning. | EVM balances never reached the model: 0 of 170 live requests in dev run 2. Agents kept calling external lookups ("I can't confirm whether the 0.1 ETH sale already went through"). | dev run 2; smoke log | `62541034b2`: renamed to `evm-wallet`; after the fix, balances appear in the prompts |
| A8 | plugin-wallet / core (design) | The wallet context has `cacheScope: "turn"`. | Planner iterations after a trade in the same turn still see pre-trade balances; the next turn sees the new ones. | mock run after A7 (calls 10–13 vs 15–18) | not changed (design choice); recorded |

| A9 | plugin-assistant reply grounding; plugin-wallet results | Honest replies are rejected, and recovery then fails the turn after the trade, so its results are lost. Nine rejected Haiku drafts in dev runs 3–4 trace to five causes: (a) limits read as holdings ("keeping at least 178.23 USDC in your wallet"); (b) traded amounts read as holdings ("the 0.1 ETH to USDC swap from your wallet"); (c) no EVM provider admitted as holdings evidence, so no EVM balance can be grounded; (d) wallet results carry no effect receipt, so recovery review rejects "I submitted tx 0x…" (review verdict: "selected effect receipt IDs are empty"); (e) the user's approval read as a settlement claim ("before you had confirmed it"). Separately, (f) completion claims are checked only against the current turn's results, so a true statement about step 1 in a later turn is always rejected (3 of the 4 financial_completion drafts). | Turns end empty right after correct trades; in dev run 4, the lost record led to a duplicate sale. | dev3 Haiku stock r1/r2, plan_guard r1/r2; dev4 Haiku stock r1, plan_guard r1 | (a)–(e) fixed: `ca3423ee4e`, `c9ada50f86`; with each turn's observed balances, 6 of the 9 drafts now pass and altered amounts are still rejected. (f) open: needs a cross-turn evidence design. |
| A10 | plugin-wallet Steward trading status | With Steward unconfigured, the context said only "Steward Trading: Unavailable". | Haiku: "The DAI purchase … needs Steward trading, which isn't configured here, so I can't carry it out yet." The WALLET swap does not use Steward. | dev run 3, stock Haiku r1 | `094ab7e94b`: the status now states its scope (Hyperliquid and Polymarket only) |

A1–A3 and A7 are defects in the stock code. A4–A5 are capability gaps that matter wherever external data services are unavailable or rate-limited. A6 is a stale-state defect, and A8 is a stale-state design choice.

## Milestone: first live completion

Dev run 3, stock_fixed `gpt-6-luna`, D1/normal, at commit `8e2edb93b4` (fixes A1–A7 plus protocol v2-elizaos-3):
- sold exactly 0.1 ETH;
- quoted step 2 with simulate;
- swapped exactly 59.406476 USDC for DAI.

The final balances equal the deterministic oracle's to the wei (178.23 USDC, 59.046981018462803274 DAI), and the audit passes. The closing declaration is missing only because the $0.12 development cap was used up during the closing turn.

## B. Behaviour that the fixes do not remove (the plan_guard motivation)

**B1, a completed step re-proposed and confirmed.** Dev run 1, stock_fixed Luna, episode r1, with A1–A3 fixed:
1. The user's "yes" executed the sale.
2. In the next turn, the agent proposed the already-completed sale again instead of executing the pending step 2.
3. The scripted user approved what was asked, and the sale executed a second time. The agent's own reply reported the second transaction hash.

The mandatory confirmation gate does not prevent this: it binds a confirmation to the parameters, not to whether the step already happened. Under plan_guard the second redemption is refused with `PlanStepEnforcer:step-already-completed`. That refusal was observed once in live-1c.

**B2, the wrong quantity for step 2.** In the same episode the agent proposed "Swap 37.31 USDC → DAI", using the DAI goal as the USDC input. That would under-deliver the goal. Under plan_guard, a step 2 that misses the goal floor is refused with `BalanceFloorEnforcer:below-floor`.

## C. Harness lessons (ours, not the framework's)

- **Ledger order:** concurrent model calls finish out of order, so the ledger is now sorted before the numbering check.
- **Budget reservations:** the proxy reserves worst-case cost before each call. plugin-anthropic asks for up to 64,000 output tokens for unknown model ids, so each Haiku call reserves about $0.032. Caps have to leave room for that.
- **Budget exhaustion:** when the budget ran out, the planner retried refused calls hundreds of times. The harness now ends the episode as `budget_exhausted`.
- **Shell loops:** a zsh word-splitting slip started four runs with an invalid condition. They exited before any model call (empty folders, removed).
