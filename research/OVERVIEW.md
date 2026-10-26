# Containing transacting agents: draft overview for Srisht

Status: 2026-10-26 — supervisor draft. The paper draft is [`paper/main.tex`](paper/main.tex) (IEEE conference format; compile on Overleaf or with any LaTeX). Every number below links to the file it comes from.

## The problem in one paragraph

LLM agents now hold crypto wallets and carry out multi-step trades for users: "sell 0.1 ETH, then buy at least 37.31 DAI, but keep at least 178.23 USDC". When the agent makes a mistake, the transaction is irreversible. In our runs agents:
- sold twice after losing the first receipt;
- spent the goal number as the input amount;
- declared "done" or "in progress" against what the chain showed.

Agent frameworks add off-chain safeguards (confirmation prompts, output checks), and wallets offer on-chain permission rules. **Nobody has measured which of these layers actually stops which failure.** That is our question. Our claim is about *containment* (what reaches the chain), not about making agents reliable.

## What we built

1. **A benchmark on a copy of Ethereum.** It runs a real, deployed agent framework (ElizaOS v2) end to end, with real models, on a pinned fork of mainnet. It injects faults: a hidden receipt, and a price move that keeps the goal feasible or makes it infeasible. Scores come from chain state, and every run is audited: a verifier recomputes everything and rejects 9 kinds of tampering. ([harness](agent-harness-v2/), [protocol](agent-harness-v2/protocol.md))
2. **Two small on-chain rules for MetaMask's deployed delegation framework.** ([contracts](plan-guard/contracts/), [README](plan-guard/README.md))
   - **PlanStepEnforcer:** each step of the signed plan runs only after its prerequisites and succeeds at most once.
   - **BalanceFloorEnforcer:** after a trade, the account must still hold at least R of a token.
3. **A proof of why existing rules can't do this.** Any per-trade limit fixed when the user signs either lets a reserve breach through or refuses a legitimate trade, depending on how the market moves. And none of the 32 built-in rules can say "step 2 only after step 1". ([paper §IV](paper/main.tex))

## Main results

### 1. A stolen or hijacked agent key (no model; deterministic)

We give an attacker the agent's key and every delegation the user signed. The attacker then tries 18 actions per setting:
- repeats;
- the wrong order;
- sending funds to itself;
- an unlisted token;
- reserve breaches and goal misses;
- the legitimate steps.

That's six protection setups × four market conditions × four tasks, each action from a clean snapshot. ([summary](benchmark/matrix-v2-summary.md))

| Protection | Bad actions let through | Good actions blocked |
|---|---|---|
| None (agent key holds the funds) | 236 of 244 | 0 of 44 |
| Per-transaction rules (like PACE) | 64 | 4 |
| MetaMask built-in rules, incl. call limits | 16 | 4 |
| Our floors only (ablation) | 59 | 0 |
| Our step order only (ablation) | 84 | 0 |
| **Both our rules** | **0** | **0** |

What this shows:
- Any on-chain rules stop theft (0 of 80 attempts).
- Only our two rules together stop repeats, out-of-order steps and reserve breaches in every market condition, without blocking legitimate trades.
- The four "good actions blocked" for MetaMask's rules are exactly the case the proof predicts: the price moves, and the fixed limit refuses a trade that would have been fine.

**Gas.** Our rules cost about the same as MetaMask's call limit on the sale. On step 2 they cost about 56k gas less than the built-in rules (388,894 against 444,973).

### 2. Agent mistakes through the framework's own wallet (no model)

These are the same kinds of requests, sent through ElizaOS's wallet and confirmed the way a user would. The confirmation prompt alone let through 6–7 bad requests per setting. MetaMask's rules let through 1 in two market conditions. Ours let through 0 and blocked 0 legitimate steps, in all 12 settings. ([summary](benchmark/suite-v1-summary.md))

### 3. Who writes the plan? (48 model calls, $0.10)

The rules enforce the plan the user signed, so a wrong plan is the remaining risk. We asked four models to turn each task into a plan. ([summary](benchmark/plan-authoring-summary.md))
- GPT-6 Luna, Claude Haiku 5.5 and Claude Sonnet 5.5 were correct 36 of 36 times.
- GPT-4.1-mini got the numbers, the order and the floors right every time. But 9 of 12 times it left open which token pays for step 2: a looser plan, not a wrong number.

### 4. Live agents (development runs, small samples)

| | Live check 1 | Live check 2 (after fixing 5 framework bugs) |
|---|---|---|
| Runs that completed the task on-chain | 2 of 4 | **4 of 4** |
| Correct final statement | 0 of 4 | **3 of 4** (the 4th ran out of budget after finishing) |
| Duplicate sales | 0 | 0 |

([live-check note](notes/live-check-2-2026-10-26.md))

**Fault sweep (26 October, overnight).** D1 under all four scenarios, three protection setups, and four models (GPT-6 Luna, Claude Haiku 5.5 and Claude Sonnet 5.5 and GPT-4.1-mini), pre-declared in [the plan](notes/dev-sweep-2026-10-26-plan.md):

SWEEP_RESULTS_PLACEHOLDER

## What we learned about the framework

Getting ElizaOS v2 to trade at all, and then to finish the task, surfaced **28 numbered problems; 25 are fixed with tests**. ([change map](notes/framework-changes.md), [backlog](notes/hardening-backlog.md))
- **Provider changes silently break whole model families.** GPT-6 and the newest Claude Sonnet and Opus could not call tools through stock ElizaOS at all (A1, A11). The newest GPT-6.1 Sol still can't (A12).
- **Safety layers in the framework mostly cost progress:**
  - a password filter hid token addresses from the agent (L1);
  - output checks rejected honest replies (A9, L4, L6);
  - the agent lost track of its own earlier trades (L2).
- **The confirmation prompt approved every duplicate it was shown.** It checks the request, not the plan.

These bugs are themselves evidence for the paper's argument: you can't rely on finding every agent-framework bug, so the guarantees belong on-chain.

## How this differs from existing work

- **Fork-based scoring exists**, but not with deployed frameworks or injected faults: EVM-QuestBench and Intent2Tx.
- **Per-transaction on-chain policy exists:** PACE. It names multi-step sequences as "the most important next target".
- **Off-chain multi-step and exactly-once guards exist:** Yin 2026, CapLease, AID-Guard, ChainClaw. They note that exactly-once needs a receiver that recognises repeats; our once-only rule makes the chain that receiver.
- **Nobody we found** tests existing on-chain controls against recorded agent failures, or enforces step order, once-only and absolute floors on-chain.

Details: [literature note](notes/literature-update-2026-10-26.md).

## Honest limits

- **Development data.** The live runs use r ≤ 2, so they are counts, not rates.
- **Narrow scope.** One chain, one DEX route (a small on-chain Uniswap V2 route we had to add, disclosed), one framework family, two-step plans.
- **Constructed cases.** The matrix and wallet-suite cases are constructed: recorded failures are replayed by shape.
- **The contracts are not audited.**
- **Configuration naming.** "Stock" in our live runs means stock *controls* on our *hardened* framework. A minimal-fix comparison is planned.

## Plan to the ICBC deadline

The ICBC deadline is 14 January 2027 per aggregator sites; this still needs confirming on the official site. The full plan is in [next steps](notes/next-steps-2026-10-25.md).

| By | Milestone |
|---|---|
| 8 Nov | Freeze the benchmark spec v2 (3–4 task families) and the pre-registration |
| 15 Nov | Go/no-go |
| 29 Nov | Held-out live runs |
| 13 Dec | Analysis |
| 10 Jan | Paper |

## Questions for Srisht

1. Is **containment** (what reaches the chain, under which layer) the right main claim for ICBC?
2. Is one framework plus the compromised-agent matrix enough, or do we need a second agent framework (e.g. Coinbase AgentKit) or a minimal reference agent?
3. Should the adversarial (stolen-key) results lead the paper, or the live-agent results?
4. Should the paper compare a minimal-fix framework with the hardened one?
5. Is the scope realistic for 14 January?
