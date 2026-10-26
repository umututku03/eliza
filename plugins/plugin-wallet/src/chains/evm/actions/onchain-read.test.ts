import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { evmBalanceHandler, evmTxStatusHandler, walletSubmissionCacheKey } from "./onchain-read";

const HASH = `0x${"ab".repeat(32)}`;
const OWNER = "0x6FF2e0DA2E0bcb67e7F5a7Cf55B2D2Fe92046aE0";

const client = vi.hoisted(() => ({
  getTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(),
  getBlockNumber: vi.fn(),
  getBalance: vi.fn(),
}));

vi.mock("../providers/wallet", () => ({
  initWalletProvider: vi.fn(async () => ({
    chains: {
      mainnet: { id: 1, name: "Ethereum", nativeCurrency: { symbol: "ETH" } },
    },
    getAddress: () => OWNER,
    getPublicClient: () => client,
  })),
  trackedTokenBalances: vi.fn(async () => ({
    lines: [],
    holdings: [{ chain: "mainnet", symbol: "USDC", amount: "237.636476", token: "0xA0b8" }],
  })),
}));

function runtime(cache: Record<string, unknown> = {}): IAgentRuntime {
  return {
    getCache: vi.fn(async (key: string) => cache[key]),
  } as unknown as IAgentRuntime;
}

describe("on-chain wallet reads", () => {
  it("reports a mined transaction with the operation the wallet recorded", async () => {
    client.getTransactionReceipt.mockResolvedValueOnce({
      status: "success",
      blockNumber: 100n,
    });
    client.getBlockNumber.mockResolvedValueOnce(101n);
    const result = await evmTxStatusHandler(
      runtime({
        [walletSubmissionCacheKey(HASH)]: { chain: "mainnet", subaction: "swap" },
      }),
      { target: "ethereum", transactionHash: HASH }
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      subaction: "tx_status",
      chain: "mainnet",
      receiptStatus: "success",
      blockNumber: "100",
      confirmations: 2,
      operation: "swap",
    });
    expect(result.text).toContain("swap transaction");
  });

  it("distinguishes reverted, pending and unknown transactions, without inventing an operation", async () => {
    client.getTransactionReceipt.mockResolvedValueOnce({
      status: "reverted",
      blockNumber: 100n,
    });
    client.getBlockNumber.mockResolvedValueOnce(100n);
    const reverted = await evmTxStatusHandler(runtime(), { transactionHash: HASH });
    expect(reverted.data).toMatchObject({ receiptStatus: "reverted", operation: null });

    client.getTransactionReceipt.mockRejectedValueOnce(new Error("not found"));
    client.getTransaction.mockResolvedValueOnce({ hash: HASH });
    const pending = await evmTxStatusHandler(runtime(), { transactionHash: HASH });
    expect(pending.data).toMatchObject({ receiptStatus: "pending" });

    client.getTransactionReceipt.mockRejectedValueOnce(new Error("not found"));
    client.getTransaction.mockRejectedValueOnce(new Error("not found"));
    const unknown = await evmTxStatusHandler(runtime(), { transactionHash: HASH });
    expect(unknown.data).toMatchObject({ receiptStatus: "not_found" });
  });

  it("refuses a malformed hash", async () => {
    const result = await evmTxStatusHandler(runtime(), { transactionHash: "0x91a6" });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ error: "INVALID_HASH" });
  });

  it("reads the configured wallet's native and tracked balances", async () => {
    client.getBalance.mockResolvedValueOnce(899863606673511392n);
    const result = await evmBalanceHandler(runtime(), { target: "mainnet" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      subaction: "balance",
      address: OWNER,
      scope: "configured_wallet",
      holdings: [
        { chain: "mainnet", symbol: "ETH", amount: "0.899863606673511392" },
        { chain: "mainnet", symbol: "USDC", amount: "237.636476" },
      ],
    });
  });
});
