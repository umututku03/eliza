# Literature check: on-chain binding of an agent's multi-step plan

23 October 2026. The question was whether "the user approves a multi-step plan once; a contract lets the agent execute each step at most once, in order, within the user's bounds" is already done for LLM agents.

**Read** = arXiv abstract and HTML. Only the first ~39k characters of each HTML were verbatim. Points marked *(summary)* rest on a fetch-tool summary of later sections.

## Verdict: the mechanism is mostly existing parts; what remains open is evaluating it on real agents' failures

**Mechanism: mostly covered.**
- Per-transaction on-chain policy for LLM agents exists: PACE (B1).
- Exactly-once authorisation that defeats an agent re-proposing a step under a fresh request exists off-chain: CapLease (B2), AID-Guard (B3).
- MetaMask's delegation framework (B6) already provides, on-chain:
  - single-use delegations (`IdEnforcer`, `LimitedCallsEnforcer`);
  - exact-calldata checks;
  - minimum balance-change (received amount) checks;
  - custom enforcers with before/after hooks.

**What none provides:**
- ordering or dependencies between steps (step 2 only after step 1);
- bounds on a step relative to what an earlier step actually produced.

Both fit in one custom caveat enforcer. **That is an engineering increment, not a paper on its own.**

**Open (no source found):** taking the failures that **deployed agent frameworks** actually produce on a mainnet fork under transaction faults, and measuring which of them each existing on-chain control layer stops:
- the per-transaction policy (PACE-style caps, allowlists);
- single-use delegations;
- exact calldata;
- balance-change checks;
- plan ordering.

The cost: legitimate actions blocked, plus gas.

PACE says its guarantee does not cover multi-transaction sequences: a five-leg drain with each leg under the cap passed every guard, PACE included. It names multi-step agent loops "the most important next target". The paper calls its results logic-level ones from a reproducible benchmark rather than deployment-ready security. Its mainnet-fork study has no results.

**Timing risk:** the PACE group (Houston/PayPal) may publish the multi-step version first.

## Sources

### B1 — Karanjai et al. (Houston, PayPal), "PACE: Policy-Attested Contract Execution for Safe AI Agents in DeFi" (arXiv 2608.17220, Aug 2026, preprint)
**Read.** Typed intents and a deterministic verifier produce a signed Policy Decision Record. A Solidity smart account re-checks the signer, calldata hash, nonce and expiry before each external call.

- **Scope:** per transaction only ("verifies one transaction at a time").
- **Duplicates:** a freshly attested duplicate swap within policy gets a new nonce and passes.
- **Threat model:** adversarial only (prompt injection, calldata mutation, stale simulation). Benign duplicates and framework bugs are not modelled.
- **Evaluation:** a deterministic sandbox (2,800 trials) and a live-LLM test of 595 trials (gemini-3.1-flash-lite, DeepSeek-V4-Flash, gpt-4o), on model outputs only. No agent framework, no fork results.
- **Gas:** about 29.8–31.8k per transaction.

**Use:** the closest on-chain mechanism, and its stated gap motivates our study.

### B2 — Xu et al., "Beyond Single-Use Tokens: Durable Authorization State for Replay-Resistant LLM Agent Actions" (CapLease, arXiv 2608.01710, Aug 2026, preprint)
**Read.** Authorisation keyed on canonical action identity × user confirmation, with Issue→Prepare→Commit in a SQL ledger. This defeats an agent re-proposing an already-authorised action under a fresh token.

- **Reproposal rate:** real LLMs made "4,036 semantically equivalent reproposals … 39.8%" across 10,152 trajectories under lost acknowledgements, timeouts and ambiguous results.
- **Scope:** single actions, off-chain. No DeFi, no agent framework (AgentDojo schemas only).
- **Limit:** exactly-once physical effects need an idempotent sink. A blockchain transaction is not idempotent, which is where our setting differs.

**Use:** prior art for exactly-once authorisation. It also shows that our duplicate-sale finding is a known class of model behaviour; what is new in ours is the framework-side cause.

### B3 — Tong, Dai, Guo, "AID-Guard: Stateful Authorization for Delegated Agent Effects" (arXiv 2608.21159, Aug 2026, preprint)
**Read.** One reservation per approved effect, re-validated at commit. A successor is allowed only after a terminal result or a certified no-effect.

- **Scope:** single provider-atomic effects; "non-atomic batches" are excluded. Off-chain (Python/SQLite).
- **Evaluation:** Stripe/Resend in test mode, with AgentDojo using four open models *(summary)*.

**Use:** prior art for lost-response duplicates.

### B4 — Barton et al. (DXRG), "Operating-Layer Controls for Onchain Language-Model Agents Under Real Capital" (arXiv 2604.26091, Apr 2026, preprint)
**Read.** A 21-day tournament on Base with 3,505 vaults, one model (Qwen3-235B), a custom runtime and ~300k on-chain actions.

- **Failures:** behavioural ones (rule fabrication, fee paralysis, sell cascades). Duplicates, wrong amounts and stale state are not reported.
- **Controls:** mostly prompt and off-chain policy. The on-chain part is a least-privilege operator role (swap only).
- **Plans:** tracked in the prompt and interpreted by the model; no binding.
- **Evaluation:** before/after measurement only pre-launch, with no model-alone vs harness control.

**Use:** real-capital evidence that the harness matters, and a contrast for our controlled, chain-scored design.

### B5 — Wei et al. (Beihang), "ChainClaw: A Layered Agent Framework for Reliable On-Chain Execution" (arXiv 2608.05790, Aug 2026, preprint)
**Read** (partly *summary*). A planner, simulation, action guard and transaction monitor.

- **Plans:** multi-step, checked off-chain only. Nothing is enforced on-chain, and there is no at-most-once.
- **Evaluation:** 7 tasks; state-changing tasks stop at preview, without broadcasting. One model (moonshot-v1-8k) against ReAct, LangChain and OpenClaw.

**Use:** an off-chain multi-step guard to contrast with on-chain binding.

### B6 — MetaMask Smart Accounts Kit / Delegation Framework (ERC-7710), caveat enforcer reference
**Read:** docs.metamask.io caveat reference, verbatim up to `nativeTokenPayment`, then *summary*; GitHub source not read.

**Built in:**
- `id` ("Only one delegation may be redeemed with any given ID");
- `limitedCalls`;
- `exactExecution` / `exactCalldata`, `allowedCalldata`, `argsEqualityCheck`;
- `erc20BalanceChange` / `nativeBalanceChange` (minimum increase or maximum decrease);
- `erc20TransferAmount`, period and streaming caps, block and timestamp windows.

**Not found:** an enforcer that orders delegations or bounds one by another's realised output. The docs say enforcers "do not guarantee a final state post-redemption"; custom enforcers are supported.

**Use:** the baseline control stack our evaluation must include. A plan-ordering enforcer would be a small extension of it.

### Also found, lower relevance
- **Bindschaedler et al., "Bonded Recourse"** (arXiv 2609.01939, BCCA 2026): on-chain settlement of compensation after a harmful action, one action per contract, synthetic evaluation.
- **He and Yu, "Cognitive Serializability"** (arXiv 2609.20261): database commit gate with idempotent retries, synthetic, not on-chain.
- **Alqithami, survey** (arXiv 2601.04583): calls for verifiable policy enforcement and reproducible evaluation; no experiments.
- **Zodiac Roles v2:** parameter conditions and value allowances, no call-count limit found.
- **CoW ComposableCoW:** conditional orders under a Merkle root, executed by watchtowers. A related "pre-authorised order set", but not agent-specific.

## What this means for the paper

1. **Do not claim** the plan contract as the main contribution. At most, it is a small custom enforcer that fills the ordering and outcome-relative gap, reported as one control among others.
2. **Main contribution (open):** a coverage matrix of measured failures × control layers.
   - **Rows:** failures from deployed agent frameworks on a pinned mainnet fork under faults, scored from chain state. That means Spartan/ElizaOS 1.x, ElizaOS v2 and, if feasible, AgentKit. The failures are duplicate sales, wrong-step trades, clamped or changed amounts, and parser-induced misroutes.
   - **Columns:** existing on-chain controls, PACE-style per-transaction policy and MetaMask caveat stacks, plus the ordering enforcer.
   - **Readouts:** unsafe effects stopped, legitimate actions blocked, gas.
3. **Much of (2) is free:** recorded agent transactions can be replayed against each control configuration on the fork without new model calls. New framework runs are the paid part.
4. **The model-vs-framework attribution** (model-only harness on the same fork) stays as the explanation of *why* the failures occur. It is secondary to the controls evaluation.
