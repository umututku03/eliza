# Research draft: containing transacting agents (for supervisor review)

**This PR is for review only, on our own fork. It is not meant for upstream ElizaOS.**

## What this is

A transacting agent can repeat a completed sale, spend the wrong amount, or report an outcome the chain contradicts. This branch measures which control layer stops which of these before they reach the chain:
- the framework's own confirmation prompt;
- MetaMask's built-in delegation rules;
- two new on-chain rules: step order with once-only success, and absolute balance floors.

It runs a deployed framework (ElizaOS v2) on a pinned Ethereum mainnet fork.

**Start with [`research/OVERVIEW.md`](../OVERVIEW.md).** It's a plain-language summary with every number linked to its source. The paper draft is [`research/paper/main.tex`](../paper/main.tex).

## Headline results

- **Stolen or hijacked agent key, all four tasks** ([summary](../benchmark/matrix-v2-summary.md)): this is the deterministic matrix, with no model involved.
  - Our two enforcers let through **0 of 244** bad actions and block **0 of 44** legitimate ones.
  - MetaMask's built-in rules let through 16 and block 4 legitimate trades.
  - A per-transaction policy lets through 64.
- **Gas.** Our sale costs the same as the built-in call limit. Our step 2 is about 56k gas cheaper than the built-in plan.
- **Who writes the plan?** ([summary](../benchmark/plan-authoring-summary.md)) Three of four models produced a fully correct plan 36 of 36 times. GPT-4.1-mini left step 2's input token open in 9 of 12.
- **Live fault sweep** ([results](dev-sweep-2026-10-26-results.md)): 59 ElizaOS episodes across four models, every cohort audited.
  - With no on-chain controls, **15 unsafe effects** reached the chain: duplicate sales, reserve breaches, goal-missing trades and stray swaps.
  - With MetaMask's built-in rules, or with ours: **0**. Part of this gap is behavioural: in protected mode the agents attempted fewer bad actions. The stolen-key matrix is what separates the layers.
  - Our rules refused **no legitimate step**.
- **A second, framework-free agent** ([summary](../benchmark/reference-agent-summary.md)): 31 of 32 correct. The one mistake reached the chain only without our rules; with them, the chain refused it.

## How to review (suggested order)

1. [`research/OVERVIEW.md`](../OVERVIEW.md), then the [paper draft](../paper/main.tex).
2. The enforcers: [`research/plan-guard/contracts/`](../plan-guard/contracts/), about 100 lines of Solidity, and their [README](../plan-guard/README.md).
3. The matrix: [`research/benchmark/compromised-agent-matrix.ts`](../benchmark/compromised-agent-matrix.ts).
4. The harness: [`research/agent-harness-v2/`](../agent-harness-v2/), with the [protocol](../agent-harness-v2/protocol.md) and the verifier `verify-v2.py`.
5. The framework changes: [`framework-changes.md`](framework-changes.md) maps all of them, each with its bug ID, commit and test. Most are fixes needed to make ElizaOS trade on a fork at all.

## What changed outside `research/`

Every change is listed in [`framework-changes.md`](framework-changes.md):
- **Framework bug fixes** in `packages/core` and `plugins/plugin-{assistant,wallet,anthropic,openai}`, each with a regression test.
- **Research-only additions:**
  - a small on-chain Uniswap V2 swap route (stock ElizaOS quotes only through HTTP aggregators, which a fork can't reach);
  - the wallet's plan-guard mode.

## Validation

Pinned Node 24.15.0 and Bun 1.4.2.

| Check | Result |
|---|---|
| core | 382 passed (the 2 known `logger.native-esm` environment failures are unchanged) |
| plugin-assistant | 2,743 passed |
| plugin-wallet | 230 passed (1 skipped) |
| plugin-anthropic | 29 passed (including the new A11 wire test) |
| Fork route control | 12/12 at the final head |
| Mock cells (D1 stock, D1 plan_guard) | audits PASS, 9/9 tamper cases rejected, 0 deviations at the final head |

Every live run passes its audit at the commit that produced it. Raw traces stay local, with SHA-256 checksums.

## Not in scope or still open

- **Open framework findings:** L6 and L7 (reply-check false positives) and A12 (GPT-6.1 Sol can't use tools through ElizaOS's Chat Completions path).
- **Not audited:** the enforcers.
- **Development data only:** the live runs are development runs. The benchmark pre-registration freeze and the held-out runs come next.
