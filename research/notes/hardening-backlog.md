# Fork hardening backlog

**Goal:** make our ElizaOS fork robust for multi-step on-chain tasks before any benchmark spend, by category rather than one bug per live run.

**Source:** every saved live trace so far: 13 result folders, 23 episodes, gpt-6-luna and claude-haiku-5-5, dev runs 1–4.

**Rules:**
- A fix counts only when a replay of the recorded failure passes and a tampered version is still rejected.
- Plugin suites must pass under the pinned toolchain.

## Finish line

The fork is ready for the benchmark when all four hold:
1. Every item below is fixed, or recorded as out of scope with a reason.
2. The full plugin-assistant and plugin-wallet suites pass under the pinned toolchain.
3. Mock dry runs pass on every task and condition.
4. A small live check on both models (development task only) loses no turn to a framework error: no `REPLY_GROUNDING_FAILED` and no `EVALUATOR_INVALID_OUTPUT`.

## Test environment

**Pinned toolchain: Node 24.15.0 and Bun 1.4.2.** Under any other Node, about 110 storage-backed tests fail with "Run SQLite storage with pinned Node 24.15.0 or Bun 1.4.2". Our earlier "pre-existing failures" were this and nothing else.

Under the pinned toolchain, with all fixes in place:
- plugin-assistant passes 2,736 of 2,736 tests;
- plugin-wallet passes 218 of 218 (1 skipped).

## Items

| # | Category | Evidence | Status |
|---|---|---|---|
| H1 | Reply grounding: limits, traded amounts and user approvals misread as claims | 9 rejected Haiku drafts (A9 a, b, e) | fixed `c9ada50f86` |
| H2 | Reply grounding: no EVM holdings evidence | the same drafts (A9 c) | fixed `ca3423ee4e`, `c9ada50f86` |
| H3 | Wallet results carry no effect receipt | recovery review: "receipt IDs are empty" (A9 d) | fixed `ca3423ee4e` |
| H4 | Reply grounding: true claims about an earlier turn's effect always rejected | 3 of 4 `financial_completion` drafts (A9 f) | fixed by verification: a `tx_status` read this turn proves the claim (H7) |
| H5 | The post-turn evaluator fails on every Haiku turn | `EVALUATOR_INVALID_OUTPUT` 101 times, Haiku only | fixed `8dc111fce9` (fenced JSON accepted) |
| H6 | Anthropic: the evaluator schema exceeds the plugin's optional-parameter limit, then `json_object` is silently ignored | no evaluator request carried `output_config` | open (the root of H5) |
| H7 | No on-chain way to check a transaction or refresh balances; agents call keyless external APIs instead | 89 Birdeye start failures; repeated `WALLET_SEARCH_ADDRESS` and `WALLET_TOKEN_INFO` network failures; drafts saying "could not confirm" | fixed: WALLET `tx_status` and `balance`, read on-chain; checked on the fork |
| H8 | Turn-cached context shows balances from before the turn's own trade | call 22 shows 0 USDC right after the sale (A8) | open |
| H9 | Wrong tool for a swap or a lookup (`WALLET_BRIDGE` with `action: token_info` or `swap`) | parameter errors in dev runs 2–3 | model behaviour; check whether the tool descriptions invite it |

## Checked and not a defect

- **The confirmation gate:** in dev run 4, the second sale came after an explicit "Yes, confirm." to a re-proposed sale. Haiku's statement that it "sent that swap before you had confirmed it" is false.
- **"cli-inference … session limit":** this is a fixture string in two message tests, not a real model call.
- **"TEXT_LARGE … Service Unavailable" (25 times):** these are our proxy's budget refusals in dev run 1 (fixed in the harness), not provider failures.
