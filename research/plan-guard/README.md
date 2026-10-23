# plan-guard: plan-bound caveat enforcers for agent wallets

Two small caveat enforcers for MetaMask's delegation framework (ERC-7710, deployed v1.3.0). With them, a user signs a whole multi-step plan once, and the chain refuses agent transactions outside it.

- **`PlanStepEnforcer`** (`contracts/PlanStepEnforcer.sol`): binds a delegation to step *i* of a plan.
  - The step runs only after its prerequisite steps, and succeeds at most once.
  - A reverted execution rolls back with the redemption, so a failed step can be retried.
  - Try-mode execution is refused.
- **`BalanceFloorEnforcer`** (`contracts/BalanceFloorEnforcer.sol`): after the executions, the delegator holds at least `floor` of a token (or ETH).
  - The bound is absolute. MetaMask's `ERC20BalanceChangeEnforcer` is relative to the pre-call balance, so it cannot express "keep at least R" when earlier steps' output is unknown at signing (`../notes/controls-check.md`).

## Fork test (`fork-test.ts` → `fork-test-results.json`)

**Setup:**
- pinned mainnet fork, block 26250601;
- MetaMask's deployed v1.3.0 DelegationManager and enforcers (code presence checked at the block);
- a HybridDeleGator user account;
- the frozen task: sell 0.1 ETH for USDC, then hold ≥ 37.31 DAI keeping ≥ 178.23 USDC;
- every plan delegation signed before step 1;
- no model calls.

**15/15 cases behave as specified:**

| Case | Per-tx policy (targets, selector, recipient, `valueLte`) | `limitedCalls` = 1 | Relative balance caps | Ours |
|---|---|---|---|---|
| Legitimate plan: sale, approve, step 2 | — | — | — | admitted |
| Repeated 0.1 ETH sale after step 1 (recorded failure) | **admitted** | refused | — | refused |
| Risk-clamped repeat, 0.0998 ETH (recorded failure) | **admitted** | — | — | refused |
| Step 2 with no plan step 1 | — | — | — | refused |
| Step 1 reverts on chain, then retried | — | — | — | admitted |
| Step 2 overspends by 5 USDC (reserve broken) | — | — | — | refused |
| Step 2 under-delivers DAI, then corrected | — | — | — | refused, then admitted |
| Step 1 −3%, step 2 spends the expected surplus (reserve broken) | — | — | cap 59.41: **admitted** | refused |
| DAI move 350 ETH, step 2 spends 52.82 (feasible) | — | — | cap 52.28: **refused** | admitted |

**Gas** (gas used by `redeemDelegations`, same fork state):

| Redemption | Gas |
|---|---:|
| Direct EOA sale, no delegation | 130,205 |
| Sale with built-in per-tx caveats | 282,557 (framework overhead +152k) |
| + `limitedCalls` | 329,925 (+47.4k) |
| + `PlanStepEnforcer` | 331,550 (+49.0k) |
| Step 2 with two relative balance caveats | 397,578 |
| Step 2 with `PlanStepEnforcer` + two floors | 388,882 |

Deployment: PlanStepEnforcer 399,478 gas; BalanceFloorEnforcer 304,337.

**Limits:**
- These are constructed cases; the recorded failures are replayed by shape (value and order), not from recorded calldata.
- The step-2 gas rows come from different pool states, so their difference is indicative only.
- The enforcers are not audited.
- Within one batched `redeemDelegations` call, prerequisite checks follow the manager's hook order, not execution order.

## Reproduce

```sh
bun install            # pinned: solc 0.8.23, @metamask/smart-accounts-kit 2.0.0, delegation-deployments 2.0.0, viem 2.30.1
bun compile.ts         # build/*.json
ANVIL_BIN=<anvil> bun --env-file=<file with MAINNET_FORK_RPC_URL> fork-test.ts --out=fork-test-results.json
```
