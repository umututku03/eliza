import {
  type Action,
  type ActionResult,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { financialCompletionIsUngrounded } from "./financial-completion";

const wallet = {
  name: "WALLET",
  description: "wallet",
  similes: [],
  examples: [],
  validate: async () => true,
  handler: async () => ({ success: true }),
  parameters: [
    {
      name: "subaction",
      description: "operation",
      required: true,
      schema: {
        type: "string",
        enum: ["swap", "transfer", "tx_status", "balance"],
      },
    },
  ],
} as unknown as Action;
const actions = promoteSubactionsToActions(wallet);

// The promoted WALLET_SWAP result recorded on a pinned mainnet fork.
const submittedSwap: ActionResult = {
  success: true,
  text: "Submitted swap on mainnet: 0xe61f",
  data: {
    actionName: "WALLET_SWAP",
    subaction: "swap",
    status: "submitted",
    mode: "execute",
    dryRun: false,
    transactionHash: "0xe61f",
  },
};

describe("financial completion grounding", () => {
  it("does not read the user's approval as a settlement claim", () => {
    // claude-haiku-5-5 reply, recorded in the same turn as the swap result.
    const reply =
      "A swap of 0.1 ETH to USDC was submitted from your wallet (transaction 0xe61f), but I could not confirm whether it executed on-chain because the status lookups failed. I also made a mistake: I sent that swap before you had confirmed it, which I should not have done.";
    expect(
      financialCompletionIsUngrounded(reply, [submittedSwap], actions),
    ).toBe(false);
  });

  it("grounds a claim about an earlier turn's swap in this turn's on-chain read", () => {
    const txStatus = (receiptStatus: string, operation: string | null) => ({
      success: true,
      text: "",
      data: {
        actionName: "WALLET_TX_STATUS",
        subaction: "tx_status",
        transactionHash: "0x91a6",
        receiptStatus,
        operation,
      },
    });
    const reply =
      "The 0.1 ETH to USDC swap was submitted earlier and has settled on-chain.";
    expect(
      financialCompletionIsUngrounded(
        reply,
        [txStatus("success", "swap")],
        actions,
      ),
    ).toBe(false);
    // Without this turn's evidence, or with weaker evidence, the claim stays ungrounded.
    for (const results of [
      [],
      [txStatus("reverted", "swap")],
      [txStatus("pending", "swap")],
      [txStatus("success", null)],
      [txStatus("success", "transfer")],
    ]) {
      expect(financialCompletionIsUngrounded(reply, results, actions)).toBe(
        true,
      );
    }
  });

  it("still rejects a settlement claim backed only by a submission", () => {
    for (const reply of [
      "The 0.1 ETH to USDC swap settled.",
      "I swapped 0.1 ETH to USDC after you confirmed it.",
    ]) {
      expect(
        financialCompletionIsUngrounded(reply, [submittedSwap], actions),
      ).toBe(true);
    }
  });
});
