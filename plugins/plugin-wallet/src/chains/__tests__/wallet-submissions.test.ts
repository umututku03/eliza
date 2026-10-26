import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  recentWalletSubmissions,
  recordWalletSubmission,
  walletSubmissionLines,
} from "../wallet-submissions";

function runtime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  } as unknown as IAgentRuntime;
}

const sale = {
  transactionHash:
    "0x91a67de983433b603a6261a46fdf94ba88d982faac815f6982bbe11a49d314fb",
  chain: "mainnet",
  subaction: "swap",
  amount: "0.1",
  fromToken: "0x0000000000000000000000000000000000000000",
  toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  submittedAt: "2026-10-25T23:00:00.000Z",
};

describe("wallet submission history", () => {
  it("keeps the most recent first, without repeating a hash, capped at 10", async () => {
    const rt = runtime();
    await recordWalletSubmission(rt, sale);
    await recordWalletSubmission(rt, {
      ...sale,
      transactionHash: "0x02",
      amount: "59.406476",
    });
    await recordWalletSubmission(rt, {
      ...sale,
      transactionHash: sale.transactionHash.toUpperCase().replace("0X", "0x"),
    });
    const recent = await recentWalletSubmissions(rt);
    expect(recent.map((entry) => entry.transactionHash.toLowerCase())).toEqual([
      sale.transactionHash,
      "0x02",
    ]);
    for (let i = 0; i < 12; i++)
      await recordWalletSubmission(rt, { ...sale, transactionHash: `0x1${i}` });
    expect(await recentWalletSubmissions(rt)).toHaveLength(10);
  });

  it("renders each submission with its hash for the wallet context", () => {
    expect(walletSubmissionLines([sale])).toEqual([
      `2026-10-25T23:00:00.000Z mainnet: swap 0.1 0x0000000000000000000000000000000000000000 -> 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (tx ${sale.transactionHash})`,
    ]);
  });
});
