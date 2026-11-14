# Workstreams after the chain-faults merge: specs for parallel subagents (14 November 2026)

Status: 2026-11-14, written by Claude. Each workstream runs as its own subagent in its own git worktree, branched from the **merged** base: `research/chain-faults` accepted, then merged into `research/evidence-layer`. Claude reviews and merges each branch.

## Rules for every workstream (non-negotiable)

- **No paid model calls.** Mock mode, unit tests and deterministic controls only. Paid stages (pilots) are launched by Claude after the user approves.
- **Secrets:** never print, cat or log API keys, `.env` contents, `MAINNET_FORK_RPC_URL`, `COMPAT_*`. Refer to them by name.
- **Files:** stay inside the **file ownership** listed for the workstream. If a change outside it is required, stop and report it; do not make it.
- **Formatting:** no repo-wide formatters on `research/agent-harness-v2/*`. Keep the existing compact single-quote style, so diffs show only real changes.
- **Results:** never delete or overwrite results folders; use fresh `--dest` names with the workstream prefix.
- **Git:** commit in small steps on the workstream's branch, and push. Do not merge, rebase or open PRs.
- **Report:** `research/notes/report-<workstream>.md` with file-by-file changes, exact acceptance outputs, deviations and open problems.
- **Toolchain:** Node 24.15.0 and Bun 1.4.2 from `~/tools`, plus `ANVIL_BIN` and `FORK_ENV`, as in `research/README.md` → Reproduce.

---

## WS-E: chain-evidence layer and robust method

- **Spec:** `research/notes/evidence-layer-spec.md`, unchanged, plus the method additions below.
- **Branch:** `ws/evidence`.
- **Ownership:**
  - `plugins/plugin-wallet/src/chains/evm/evidence.ts` (new) and its test;
  - the two send sites in `swap.ts` and `plan-guard.ts`;
  - the wallet router's `tx_status` subaction;
  - the `--evidence` flag lines in `run-v2.ts`;
  - the verifier and tamper case for the nonce check.

**Method additions** (these make it a method, not just a layer):
1. **Ablation flags:** `EVM_EVIDENCE_ABLATE` ∈ {`none`, `no_nonce_pin`, `no_grading`, `no_refusal_decode`}.
   - `no_nonce_pin`: re-sends use a fresh nonce.
   - `no_grading`: always reports a binary success or failure, like stock.
   - `no_refusal_decode`: raw refusal text only.

   Recorded in the manifest. The harness flag is `--evidence-ablate=<x>`.
2. **Guarantee test:** a unit test plus a mock check that **at most one canonical transaction exists per (sender, pinned nonce)** in every mock episode, in all fault cells and both wallet modes. In plan mode, also **at most one successful redemption per plan step**, which PlanStepEnforcer enforces on chain.
3. **The mock naive re-sender** (`--mock-agent=naive`) from the spec, run in all four fault cells × {stock, plan_guard} × {no layer, layer, each ablation}. Expected:
   - no layer: duplicates in the landed cells;
   - full layer: 0 duplicates;
   - `no_nonce_pin`: duplicates return.

   Record the full table in the report.

**Acceptance:** everything in `evidence-layer-spec.md`, plus items 1–3 above.

---

## WS-B: benchmark extension

- **Branch:** `ws/benchmark`.
- **Ownership:**
  - `research/agent-harness-v2/run-v2.ts`: task handling, port flag, compound scenarios, scenario parameters;
  - `fork-oracle.ts`: ports only;
  - the new launcher `research/agent-harness-v2/bench.sh`;
  - the new scorecard `research/agent-harness-v2/scorecard.py`;
  - matching verifier entries.

**Do not touch** `evidence.ts` or the wallet plugin.

1. **Parallel runs:** `--port-base=N` offsets every fixed port:
   - LLM proxy 18650;
   - fork proxy 18546;
   - Anvil `ANVIL_PORT`;
   - mock gate 18652;
   - anything else hard-coded.

   With no flag, the old ports are used. Two mock cohorts must run at once with different port bases and both audit PASS.
2. **All four tasks:** the chain-fault scenarios (and the existing ones) must run with `--task=D1|H1|H2|H3`.
   - H1 trades DAI → USDC; H3 is pinned at block 26,100,000. Check that sale detection, fault triggers and mock amounts are derived from the task, not hard-coded.
   - The deterministic controls must reach their labels on all four tasks for the four chain faults.
3. **Compound faults:** new scenarios `stale_then_price` (rpc_stale and a price move after the sale) and `dropped_then_reorg`. In the latter, the first sale is dropped, the re-send is confirmed and then orphaned, so the agent must re-send once more; exactly one canonical sale must exist at the end.
   - **Ordering:** append them after `CHAIN_FAULTS`, keeping the predeclared order.
   - **Verifier:** each compound scenario's events must appear in the declared order.
4. **Fault parameters:** `--lag-ms`, `--reorg-delay-ms`, `--hide-ms` (defaults equal the current constants). Record them in the manifest; the verifier checks the journal against them.
5. **Scorecard:** `scorecard.py <folders...>` emits one table per (agent, model, condition, evidence):
   - per fault cell: correct-decision rate, from `metrics.py` BDT status;
   - unsafe effects;
   - median comparable IVL, median BDT, median PAF;
   - completion and cost.

   Import from `metrics.py`; do not duplicate it.
6. **Launcher:** `bench.sh` runs a list of (task, model, condition, scenarios, reps) cohorts in N parallel lanes, each with a disjoint `--port-base` and a disjoint cost cap. It audits and tamper-tests each cohort, as `live-distinguish.sh` does, and stops on any failure. Default `--mode=mock`; **live mode is refused unless `BENCH_ALLOW_LIVE=1`**, which only Claude sets after the user approves.

**Acceptance (mock):**
- four tasks × four chain faults × stock, luna mock: PASS and full tamper rejection;
- compound faults on D1: PASS;
- two cohorts in parallel: PASS;
- regression on the default and distinguishing scenarios: unchanged;
- the scorecard prints for all mock folders.

---

## WS-A: framework-agnostic adapter and a second agent

- **Branch:** `ws/agent2`.
- **Ownership:**
  - new `research/agent-harness-v2/agent2-child.ts`;
  - the `--agent=elizaos|agent2` flag lines in `run-v2.ts`;
  - verifier entries for the new agent type;
  - `research/agent-harness-v2/AGENT-INTERFACE.md` (new).

**Goal:** show the benchmark does not depend on ElizaOS. AgentPerturb's limitation asks for exactly this ("one agent scaffold").

1. **`AGENT-INTERFACE.md`:** the contract any agent must meet to be benchmarked.
   - **It receives:** the task text, an RPC URL (the fault proxy), a private key (fork test key), an LLM base URL (the egress proxy) and the turn messages.
   - **It returns:** per turn, its reply and tool calls; at the end, the one-word verdict.
   - **Scoring:** comes only from chain state.
2. **`agent2-child.ts`:** a minimal function-calling loop. There is no framework, so the second agent has a different architecture from ElizaOS.
   - **Tools:** `get_balances`, `quote_swap`, `swap` (Uniswap V2 router through viem against the given RPC), `tx_status`.
   - **Confirmation:** each swap asks once, and executes on the user's "yes", so the same user policy applies.
   - **Traffic:** model calls go through the egress proxy only; OpenAI-compatible, so luna works, and later the Anyscale model.
   - **Same child contract** as `episode-child-v2.ts`: spec in, episode record out, turn texts, the closing word.
3. **Mock mode works** with the existing mock decision logic in the egress proxy: the scripted sale, then step 2.

**Acceptance (mock):**
- `--agent=agent2` on the default four scenarios and the four chain faults, D1, stock: audit PASS and full tamper rejection; controls unchanged;
- ElizaOS regression unchanged;
- one paragraph in the report on differences that could affect comparability (tool names, confirmation flow, lack of memory).

---

## Kept by Claude (not delegated)
- Review and merge of every branch, and the full mock gate after each merge.
- Stage 0 (free mocks) and the Anyscale model integration with its single-episode smoke test. These need the user's account details.
- Pre-registration, budget proposals, and launching every paid stage after the user approves.

## Merge order
1. chain-faults.
2. ws/benchmark: ports and tasks, which the others need for parallel validation.
3. ws/evidence.
4. ws/agent2.

The `run-v2.ts` conflicts are expected to be small: each workstream owns different lines. Claude resolves them.
