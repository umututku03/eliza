# Claude continuation audit — 15 November 2026

This is a read-only evidence review and documentation correction. It launches no experiments, changes no protocol settings, freezes no study and authorizes no spending. The reviewed coordinator source is `d3917954f9`; its protocol remains explicitly unfrozen.

## What Claude finished

- The current formal model and configurations from `ws/tla` were merged through `ws/protocol` (`36d46cb208`). The model follows wallet source at `eb42064d82`, including the earlier recovery hardening; it excludes quorum reads.
- Saved logs confirm all four safety invariants for the 14 full-policy configurations. The largest checked state space is `hidden_reorg`: 2,700,886 distinct states.
- All 12 liveness property logs across six full-policy configurations end with “No error has been found.” Their distinct-state counts match the README: hidden 7,028; dropped 3,731; lostack 4,767; stale 8,258; reorg 12,031; reinclusion 7,859.
- The explicit-enabledness check passes in its 818-state configuration. This replaced the computationally expensive direct `ENABLED` evaluation for liveness. Equivalence is checked within that small configuration, not established for every larger configuration or unbounded state space.
- The coordinator and original WS-T model, generator, runner and 21 relevant configurations match byte for byte. The 14 safety configurations also match the generator's declared parameter values. Model SHA-256: `49e5070a7145f1a53c4eeedc8179be904042060c2d4aaffec5d98859eda04763`.
- The wallet source blobs at `eb42064d82` and reviewed head `d3917954f9` match. A later wallet change needs a new model-to-code mapping review before quoting these results for that source.
- The current formal regression tests use ordinary `it` assertions under both `full` and `full_quorum`; the old README instruction to convert `it.fails` was stale and is corrected.
- Coordinator commit `d3917954f9` ties random-schedule reinclusion records to the canonical outcome transaction. The earlier accepted tamper case remains part of the historical gate evidence. A new passing tamper check is needed before calling the repaired gate complete.

The existing nine `results-gate3-*.audit.json` files are saved audit results, not evidence that every subsequent protocol gate passed. In particular, they do not establish fresh three-provider quorum acceptance, final-source tamper rejection or open-model feasibility.

## Evidence inventory and limits

The local `test-results/claude-resume-1115/formal-evidence-inventory.json` contains current SHA-256 hashes of 287 formal evidence files, the checked input hashes, and the 27 successful safety/liveness/enabledness completion logs. Raw logs remain in the original `eliza-ws-tla/research/formal/logs/` worktree. No original log, result or configuration was rewritten.

This inventory was created at review time. The historical runner did not hash inputs at launch, so the inventory is not retrospective cryptographic attestation of the inputs used by those processes. The local jar hash matches the documented artifact. Saved completed logs report TLC2 2.19 and Temurin 21.0.13 **x86_64**; the Java executable installed at review time is arm64. The distribution release label v1.7.4 is distinct from the checker banner version.

The formal results remain finite model checks under the documented bounds, atomic observations, caller behavior and fairness assumptions. They are not a proof of the TypeScript program, quorum safety, general finality, or successful LLM task completion. The earlier Codex timeout logs are preserved and superseded for these particular formal claims by Claude's completed checks; they must not be presented as completed passes themselves.

## Protocol corrections proposed before freeze

These proposals leave `main-study-protocol.md` unchanged for coordinated review. They are not retrospective changes to an enrolled study.

| Current text or gap | Exact proposed correction | Reason |
|---|---|---|
| G1 uses random seeds 1001–1020, while block F requires those seeds outside every mock QA range | Use development QA seeds 1–20 for G1. Reserve 1001–1020 for block F and record the final seed lists separately. | The current two statements cannot both hold. Generator unit coverage already includes development seeds; mock task outcomes on study seeds would also violate the stated QA exclusion. |
| The fault table calls snapshot reorgs “depth 1” | Describe the emulation as reverting the critical-transaction block through the current head; report the journal's realized `depth` and the next-send/12-second trigger separately. If depth exactly one is required, treat that as a separately reviewed design change before freeze. | `fork-rpc-proxy.ts` computes `depth = h - saleBlock + 1`; approvals or idle blocks can make it greater than one. No change to the proxy is proposed here. |
| False-hold sampling “can only undercount, and only near the 5 s boundary” | State that 250 ms is a target polling interval, not a guaranteed RPC-delay bound. Report sampled receipt-effect predicates with coverage and timing limitations; do not claim one-sided error or an exact balance-history oracle. | The existing WS-S takeover note already corrects the fixed-latency interpretation. Receipt events are not current net balances, and polling delay is variable. |
| The open-weight main-study scope shares the 998-episode cheap-tier total, which includes optional Claude Code U6 | State both totals: open-weight units excluding U6 contain 944 episodes in 43 cohorts; the listed comparison including U6 contains 998 episodes in 46 cohorts. | U6's 54 episodes/3 cohorts moved to the optional paid tier. The remaining table arithmetic is unchanged. |
| G5 labels remote inference using Anyscale credits “free” before accounting and limits are fixed | Distinguish local inference with no provider charge from remote credit-consuming inference. Record endpoint, model/revision, sampling settings, token ceilings and provider accounting before launch. Credit consumption needs the user's applicable paid-call authorization. | A zero price entry in this harness is not proof that the serving provider charges zero. Existing credits do not themselves approve spending. No remote inference was launched by this audit. |
| The source and confirmation-gate placeholders remain unfilled | Fill the final source and audit references only after the new source's required checks pass; keep the protocol explicitly unfrozen until then. | Historical gate3 audits cannot certify later code changes or settings. |
| Model-to-code wording could attach historical formal totals to a later wallet automatically | Keep `eb42064d82` as the checked mapping target, with exact model/configuration hashes. Review that mapping after any recovery transition change; rerun relevant checks before attaching the totals to a new frozen source. | A model check verifies its abstraction and bounds, not arbitrary later source. |

The existing protocol already restricts protected comparisons to ElizaOS. agent2 and Claude Code use arm `none`; workflow tasks require their explicit task file and supported stock/scripted settings. Validation should use those supported combinations rather than implement new adapter behavior merely to make an invalid command pass.

## Remaining evidence gates

- Fresh required mock acceptance with the final source, including the repaired reinclusion tamper case and independent history-check agreement.
- Three-provider quorum acceptance at the preregistered fault timings, with conservative holds, missed goals and false completions retained as outcomes.
- Reconcile any remaining wallet recovery findings and then review the formal mapping against that source.
- Open-model endpoint feasibility and accounting, explicit token ceilings, final model identifiers and revision/sampling metadata.
- Final cohort files, hashes, source/gate references and the applicable model-call approval before any billed inference.

Authored-by: Codex (OpenAI).

## Integration chronology

The draft consistency proposals above were subsequently applied to the unfrozen main-study protocol. Its source and gate placeholders remain unfilled. No paid inference or study launch was authorized. The seed-10 implementation patch is commit `e1c82ae7a3`, supported by 105 targeted tests, 337 passing wallet tests (one skipped), and a clean wallet typecheck. Fresh mock confirmation is pending separately; this audit does not infer its result.
