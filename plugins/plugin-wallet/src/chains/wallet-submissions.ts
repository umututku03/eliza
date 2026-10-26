/**
 * The wallet's own recent submissions, kept across turns. Action results live
 * for one turn, so without this an agent loses the hashes of its earlier
 * trades and cannot check them with `tx_status` (live check: "I don't have
 * the actual transaction hash" for a sale two turns earlier).
 */
import type { IAgentRuntime } from "@elizaos/core";

const SUBMISSIONS_CACHE_KEY = "wallet:submissions";
const MAX_SUBMISSIONS = 10;

export interface WalletSubmission {
  transactionHash: string;
  chain: string;
  subaction: string;
  amount?: string;
  fromToken?: string;
  toToken?: string;
  to?: string;
  submittedAt: string;
}

export async function recentWalletSubmissions(
  runtime: IAgentRuntime,
): Promise<WalletSubmission[]> {
  const stored = await runtime.getCache<WalletSubmission[]>(
    SUBMISSIONS_CACHE_KEY,
  );
  return Array.isArray(stored) ? stored : [];
}

/** Most recent first; a re-recorded hash moves to the front instead of repeating. */
export async function recordWalletSubmission(
  runtime: IAgentRuntime,
  submission: WalletSubmission,
): Promise<void> {
  const hash = submission.transactionHash.toLowerCase();
  const previous = (await recentWalletSubmissions(runtime)).filter(
    (entry) => entry.transactionHash.toLowerCase() !== hash,
  );
  await runtime.setCache(
    SUBMISSIONS_CACHE_KEY,
    [submission, ...previous].slice(0, MAX_SUBMISSIONS),
  );
}

export function walletSubmissionLines(
  submissions: readonly WalletSubmission[],
): string[] {
  return submissions.map((entry) => {
    const what =
      entry.subaction === "transfer"
        ? `transfer ${entry.amount ?? "?"} ${entry.fromToken ?? ""} to ${entry.to ?? "?"}`
        : `${entry.subaction} ${entry.amount ?? "?"} ${entry.fromToken ?? "?"} -> ${entry.toToken ?? "?"}`;
    return `${entry.submittedAt} ${entry.chain}: ${what.replace(/\s+/g, " ").trim()} (tx ${entry.transactionHash})`;
  });
}
