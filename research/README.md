# Research: plan-bound execution for agent wallets

This branch of our ElizaOS fork holds the research work. It is not for upstream.

- `plan-guard/`: caveat enforcers for MetaMask's delegation framework (plan step order and once-only execution, absolute balance floors), with a pinned mainnet-fork test against the deployed v1.3.0 contracts.
- `notes/`:
  - `literature-plan-binding.md`: related-work check;
  - `controls-check.md`: which existing on-chain controls stop the recorded agent failures, and the reserve-floor gap;
  - `expressiveness-results.json`: the fork data for that gap.

**The Spartan (ElizaOS 1.x) baseline**, with its Ethereum port, recorded cohorts and fork harness, is in `umututku03/spartan-agent`. The next step here is to run stock ElizaOS v2 (`research/v2-base`) on the same fork and tasks, then our changes.

Fork access needs `MAINNET_FORK_RPC_URL` in an env file that is never committed. Use fork-only test keys only.
