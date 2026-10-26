# Literature update: 26 October 2026

This update follows `literature-plan-binding.md` (23 October).

**Question:** does anything published or posted cover our three components?
1. Failures of a **deployed agent framework** executing multi-step DeFi swaps on a **pinned mainnet fork** under **injected transport faults**, scored from chain state.
2. Which **existing on-chain controls** (MetaMask delegation caveats) stop those failures.
3. **On-chain enforcers** for step order, once-only execution, and absolute post-trade floors.

**Method:**
- Web search (extended), then full reads of the closest papers.
- Read = arXiv abstract plus HTML. The first ~39k characters of each HTML were read verbatim; the rest came from a fetch-tool summary, marked *(summary)* where a claim depends on it.
- Not exhaustive. Re-run before submission.

## Verdict

**None of the papers found covers (2) or (3).**

**(1) is partly covered:** fork-based, state-scored DeFi execution is now established.
- **EVM-QuestBench:** multi-turn, chain-feedback loop on a BSC fork.
- **Intent2Tx:** single-step generation on an Ethereum fork.

We must not claim "agents on a fork scored from chain state" as new. These remain open:
- a **deployed third-party framework** (ElizaOS) run end to end;
- **injected transport faults** (hidden receipts, price moves) on a **pinned** fork;
- **duplicate-effect and reserve-violation** metrics.

Two recent papers name our gap as their open problem:
- **2608.00783:** "plan transactionality … the open problem we regard as most worth attacking"; scope predicates (caps, allowlists, rate limits) "the most valuable single extension".
- **PACE (2608.17220):** multi-step agent loops "the most important next target".

The window is open but narrowing.

## Papers

| Paper | What it is | (1) | (2) | (3) |
|---|---|---|---|---|
| **Yin, "Safety Invariants for Agents Orchestrating Irreversible State Transitions"** (arXiv 2608.00783, Aug 2026, single author, Datumpont AI, preprint) | Off-chain invariants in a custom wallet agent: confirm gate, pre-state check, post-state polling, no phantom success, scoped delegation, verify-then-retry, idempotent receiver. Fault model includes outcome ambiguity, re-issue and duplicate delivery. 60-prompt suite judged by an LLM; 108 production writes on 8 chains; a real duplicated 200 USDT swap. | partial: real failures, but own system, no fork, no injected faults, intent judged rather than chain state | no | no: off-chain; plans get "prefix consistency, not atomicity"; pre-trade non-negativity only |
| **PACE** (arXiv 2608.17220, Houston/PayPal) | Per-transaction signed policy records verified by a smart account. Sandbox with a mock LLM; 0.00 unsafe on 40 tasks. | no | per-transaction on-chain policy; no multi-step | no |
| **DeFiFlowBench** (arXiv 2609.11504, Sep 2026, SRM) | 207 prompts → DeFi workflow graphs; static safety predicates plus a local constant-product AMM; repair layer injects safety parameters. | no: workflow synthesis, no agent, no fork execution, no faults | no | no: pre-execution price-impact cap only |
| **EVM-QuestBench** (arXiv 2601.06565, ACL 2026 per search, not confirmed on the paper's own pages) | 107 tasks; generated ethers.js code; multi-turn loop with chain feedback; BSC fork at the latest block; final-state scoring. | **partial (closest):** multi-step, fork, state-scored; but no framework, no faults, unpinned, no duplicate or reserve metrics | no | no |
| **Intent2Tx** (arXiv 2604.27763, Apr 2026, PKU) | ~31.5k intents from mainnet traces; one-shot transaction JSON; Ethereum fork; scored on state-effect equality with the reference. | partial: fork, state effect; single-shot, no agent | no | no |
| **Proof of Execution** (arXiv 2607.05397, AlphaBitCore) | Off-chain gateway plus a signed, hash-linked event log; synthetic tamper tests. | no | no | ordering only as trace tamper-evidence, off-chain; no once-only, no floors |
| **ChainClaw** (2608.05790), **CapLease** (2608.01710), **AID-Guard** (2608.21159) | As in the 23 October note: off-chain multi-step guard; off-chain exactly-once authorisation. | – | – | off-chain |
| **Paper Agents, Paper Gains** (arXiv 2605.29174, Pantera/Stanford/IC3) | Market and PnL study of ElizaOS and Virtuals agents; describes ElizaOS architecture. | background only | no | no |
| **AI Agents in Cryptoland** (IACR ePrint 2025/526), **CrAIBench** (arXiv 2503.16248) | Attacks on ElizaOS: context and memory manipulation, mainnet-vs-testnet transfers. | adversarial, not benign framework faults | no | no |
| CyberChainBench (EMNLP Findings 2026), CAIA (2510.00332), CryptoBench (2512.00417) | Exploit or analysis benchmarks; adversarial markets. | different task | no | no |

## Consequences for the paper

1. **Position.** We are the first to run a **deployed** agent framework end to end, on a **pinned** mainnet fork with **injected transport faults**, and to measure, from chain state, **which on-chain control layers contain the resulting effects**. Cite EVM-QuestBench and Intent2Tx for fork-based state scoring, and differentiate on all four bolded points.
2. **Mechanism.** The step-order and absolute-floor enforcers are now positioned as **on-chain realisations of what 2608.00783 and PACE name as open** (plan transactionality, multi-step loops). Still not the sole contribution: they are the column that closes the gap in the coverage matrix.
3. **Use these baselines:**
   - 2608.00783's off-chain invariants: we already have analogues of its confirm gate, post-state observability, no-phantom-success and verify-then-retry in the hardened fork;
   - PACE-style per-transaction policy;
   - MetaMask built-in caveats.

   An off-chain-vs-on-chain comparison under the same faults is a natural, unclaimed experiment.
4. **Risk.** Three groups (PACE, 2608.00783, EVM-QuestBench's) are one step from this. Move to a preprint quickly once results exist.

## Stated open problems across recent work

**Sources:** the limitations and future-work sections of PACE, CapLease, AID-Guard, ChainClaw, CrAIBench and 2608.00783, plus two agenda-setting surveys:
- Alqithami (arXiv 2601.04583, Jan 2026), a review of 317 works;
- Mao et al., SoK on agentic commerce (arXiv 2604.15367, Apr 2026).

**Coverage:** the surveys' later sections were partly unreadable. A "Failure Recovery Test" attributed to Alqithami §9 could not be verified; do not cite it.

| Recurring open problem | Who states it | What we have |
|---|---|---|
| **1. Evaluation on real chains or forks, with real agent frameworks** | All five guard papers (simulators, no broadcast, test-mode providers). The SoK says reproduction "with irreversible on-chain transactions … remains an open experimental challenge" (V-A1) and "finance-specific benchmark harnesses are still needed" (V-E). Alqithami calls for "a reproducible evaluation suite and benchmarks" (abstract). PACE's fork study has no results. | Pinned-fork harness, a deployed framework (ElizaOS v2), injected faults, chain-state scoring, audits. |
| **2. Guarantees beyond a single action** | PACE: "multi-step agent loops that compose policy-valid legs into a harmful sequence, remain open and are the most important next target" (alongside adaptive attackers). 2608.00783: plan transactionality. CapLease and AID-Guard are scoped to one authorization or reservation; AID-Guard excludes "non-atomic batches". | PlanStepEnforcer: order and once-only across a signed plan, on-chain. |
| **3. Exactly-once needs an idempotent sink** | CapLease: "Without [sink idempotency], CapLease cannot guarantee exactly-once physical effects." AID-Guard: providers without idempotency are "ineligible" for retry and recovery. A transaction is not idempotent. | Once-only on-chain gives the chain the idempotency the sink lacks: a re-proposed step reverts. **This framing is not stated anywhere we read.** |
| **4. Guards refuse legitimate actions** | AID-Guard: −35 to −44 pp benign utility. PACE: 5.0–12.8% live benign false positives; 0.25 under a conservative policy. CrAIBench: DataSentinel has 40% false alarms. DeFiFlowBench: permissive thresholds still admit unsafe trades. | The absolute floor versus relative caps: the controls suite measures off-plan admitted *and* in-plan refused; relative caps refuse feasible trades under over-delivery (controls-check.md). |
| **5. Policy authoring dominates safety** | PACE: "Pace's safety rests on the policy values a deployer chooses." CapLease Table 7: wrong trusted inputs give 0.94–0.97 unsafe. AID-Guard: "given a correct contract". | Open for us too: who writes the plan? We should measure it, not hide it (see the options note). |
| **6. Trusted off-chain state** | AID-Guard (SQLite in the TCB, rollback undetected), CapLease (centralized, non-rollback ledger), ChainClaw (LLM-based guard pass). | On-chain enforcement removes the trusted ledger. |

**Direction these support:** a benchmark of transacting agents under faults (problem 1) whose control columns compare off-chain guards with on-chain per-transaction and on-chain sequence-level containment (problems 2, 3 and 6). It reports admitted unsafe effects *and* refused legitimate ones (problem 4), and treats plan authoring as an explicit variable (problem 5).
