/**
 * On-chain reads for the WALLET router: the status of a transaction and the
 * configured wallet's balances, both read from the chain's RPC at call time.
 * Neither needs an external data service, so an agent can verify its own
 * earlier effect (and the message runtime can ground claims about it) on any
 * configured EVM chain, including a local fork.
 */
import type { ActionResult, IAgentRuntime } from "@elizaos/core";
import { formatEther, isHash } from "viem";
import { initWalletProvider, trackedTokenBalances } from "../providers/wallet";
import type { SupportedChain } from "../types";

/** Cache key under which the router records the operation of each transaction it submitted. */
export function walletSubmissionCacheKey(hash: string): string {
  return `wallet:submitted:${hash.toLowerCase()}`;
}

export interface WalletSubmissionRecord {
  chain: string;
  subaction: string;
}

type WalletProvider = Awaited<ReturnType<typeof initWalletProvider>>;

function resolveChain(walletProvider: WalletProvider, target: unknown): SupportedChain | undefined {
  const names = Object.keys(walletProvider.chains);
  if (typeof target !== "string" || target.trim() === "") {
    return names.length === 1 ? (names[0] as SupportedChain) : undefined;
  }
  const wanted = target.trim().toLowerCase();
  const aliases: Record<string, string> = { ethereum: "mainnet", eth: "mainnet" };
  return names.find((name) => {
    const chain = walletProvider.chains[name];
    return (
      name.toLowerCase() === wanted ||
      name === aliases[wanted] ||
      chain.name.toLowerCase() === wanted ||
      String(chain.id) === wanted
    );
  }) as SupportedChain | undefined;
}

function failure(subaction: "tx_status" | "balance", text: string, code: string): ActionResult {
  return {
    success: false,
    text,
    values: { walletActionSucceeded: false, walletActionError: code },
    data: { actionName: "WALLET", subaction, error: code },
  };
}

export async function evmTxStatusHandler(
  runtime: IAgentRuntime,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const hash = params.transactionHash ?? params.hash;
  if (typeof hash !== "string" || !isHash(hash)) {
    return failure(
      "tx_status",
      "tx_status needs transactionHash: a 0x-prefixed 32-byte hash.",
      "INVALID_HASH"
    );
  }
  const walletProvider = await initWalletProvider(runtime);
  const chain = resolveChain(walletProvider, params.target ?? params.chain);
  if (!chain) {
    return failure(
      "tx_status",
      `Unknown or ambiguous chain; configured: ${Object.keys(walletProvider.chains).join(", ")}.`,
      "UNKNOWN_CHAIN"
    );
  }
  const client = walletProvider.getPublicClient(chain);
  const recorded = await runtime.getCache<WalletSubmissionRecord>(walletSubmissionCacheKey(hash));
  const operation = recorded?.chain === chain ? recorded.subaction : null;
  try {
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null);
    let receiptStatus: "success" | "reverted" | "pending" | "not_found";
    let blockNumber: string | null = null;
    let confirmations = 0;
    if (receipt) {
      receiptStatus = receipt.status === "success" ? "success" : "reverted";
      blockNumber = receipt.blockNumber.toString();
      confirmations = Number((await client.getBlockNumber()) - receipt.blockNumber) + 1;
    } else {
      receiptStatus = (await client.getTransaction({ hash }).catch(() => null))
        ? "pending"
        : "not_found";
    }
    const described = operation ? `${operation} transaction` : "transaction";
    const text =
      receiptStatus === "success"
        ? `The ${described} ${hash} on ${chain} succeeded in block ${blockNumber} (${confirmations} confirmation${confirmations === 1 ? "" : "s"}).`
        : receiptStatus === "reverted"
          ? `The ${described} ${hash} on ${chain} was mined in block ${blockNumber} but reverted; it had no effect.`
          : receiptStatus === "pending"
            ? `The ${described} ${hash} on ${chain} is known to the node but not yet mined.`
            : `No transaction ${hash} is known on ${chain}.`;
    return {
      success: true,
      text,
      values: { walletActionSucceeded: true, walletSubaction: "tx_status" },
      data: {
        actionName: "WALLET",
        subaction: "tx_status",
        chain,
        transactionHash: hash,
        receiptStatus,
        blockNumber,
        confirmations,
        operation,
      },
    };
  } catch (error) {
    return failure(
      "tx_status",
      `Could not read ${hash} on ${chain}: ${error instanceof Error ? error.message : String(error)}`,
      "RPC_ERROR"
    );
  }
}

export async function evmBalanceHandler(
  runtime: IAgentRuntime,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const walletProvider = await initWalletProvider(runtime);
  const chain = resolveChain(walletProvider, params.target ?? params.chain);
  if (!chain) {
    return failure(
      "balance",
      `Unknown or ambiguous chain; configured: ${Object.keys(walletProvider.chains).join(", ")}.`,
      "UNKNOWN_CHAIN"
    );
  }
  const address = walletProvider.getAddress();
  try {
    const client = walletProvider.getPublicClient(chain);
    const native = formatEther(await client.getBalance({ address }));
    const symbol = walletProvider.chains[chain].nativeCurrency.symbol;
    const tracked = await trackedTokenBalances(runtime);
    const holdings = [
      { chain, symbol, amount: native },
      ...tracked.holdings.filter((holding) => holding.chain === chain),
    ];
    const lines = holdings.map(
      (holding) =>
        `${holding.amount} ${holding.symbol}${"token" in holding && holding.token ? ` (token ${holding.token})` : ""}`
    );
    return {
      success: true,
      text: `Balances of the configured wallet ${address} on ${chain}, read on-chain now:\n${lines.join("\n")}`,
      values: { walletActionSucceeded: true, walletSubaction: "balance" },
      data: {
        actionName: "WALLET",
        subaction: "balance",
        chain,
        address,
        scope: "configured_wallet",
        holdings,
      },
    };
  } catch (error) {
    return failure(
      "balance",
      `Could not read balances on ${chain}: ${error instanceof Error ? error.message : String(error)}`,
      "RPC_ERROR"
    );
  }
}
