/**
 * Reproductions of counterexamples found by the TLA+ model of the evidence layer
 * (research/formal/EvidenceLayer.tla, see research/formal/README.md). Each `it.fails` states the property the
 * model checks; it passes today because evidence.ts violates it, and will start failing (so turn it into a plain
 * `it`) once the gap is closed. evidence.ts is not changed here.
 */
import { type Address, encodeFunctionData, type Hex, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EvidenceDeps,
  EvidenceError,
  type EvidenceIntent,
  describeCall,
  latestIntent,
  resetEvidenceLedgers,
  sendWithEvidence,
} from "../evidence";

const SENDER = "0x6FF2e0DA2E0bcb67e7F5a7Cf55B2D2Fe92046aE0" as Address;
const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
const ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
]);
const ACCOUNT = { address: SENDER, type: "local" };
const buyData = (tokenOut: Address) =>
  encodeFunctionData({ abi: ABI, functionName: "swapExactETHForTokens", args: [1n, [WETH, tokenOut], SENDER, 2200n] });
const buyIntent = (tokenOut: Address, value: bigint): EvidenceIntent =>
  describeCall({ chainId: 1, sender: SENDER, holder: SENDER, to: ROUTER, value, data: buyData(tokenOut) });

type Tx = { nonce: number; block: number | null; blockHash: Hex | null; to: Address; credit: Address; amount: bigint };

/** Minimal chain: one sender, nonce rule, automine on send unless `dropNext`, hidden receipts, emulated reorg. */
class Chain {
  t = 0;
  head = 100;
  nonce = 7;
  n = 0;
  hashes = new Map<number, Hex>();
  txs = new Map<Hex, Tx>();
  balances = new Map<string, bigint>();
  hidden = new Set<Hex>();
  hideNext = false;
  dropNext = false;
  constructor() {
    for (let b = 0; b <= this.head; b++) this.hashes.set(b, this.h(`b${b}`));
  }
  h(tag: string): Hex {
    return `0x${Buffer.from(tag).toString("hex").padEnd(64, "0").slice(0, 64)}` as Hex;
  }
  mine() {
    this.head++;
    this.hashes.set(this.head, this.h(`b${this.head}-${this.n++}`));
  }
  bal(token: Address) {
    return this.balances.get(token.toLowerCase()) ?? 0n;
  }
  /** Every block from `from` replaced by an empty one; its transactions are gone (not re-included). */
  reorg(from: number) {
    for (const [hash, tx] of [...this.txs])
      if (tx.block !== null && tx.block >= from) {
        this.txs.delete(hash);
        this.nonce--;
        this.balances.set(tx.credit.toLowerCase(), this.bal(tx.credit) - tx.amount);
      }
    for (let b = from; b <= this.head; b++) this.hashes.set(b, this.h(`r${b}-${this.n++}`));
  }
  canonical(credit: Address) {
    return [...this.txs.values()].filter((t) => t.block !== null && t.credit.toLowerCase() === credit.toLowerCase()).length;
  }
  notFound = (name: string) => Object.assign(new Error(`${name}: not found`), { name });
  pub = {
    getTransactionCount: async () => this.nonce,
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const tx = this.txs.get(hash);
      if (!tx) throw this.notFound("TransactionNotFoundError");
      return { blockNumber: tx.block === null ? null : BigInt(tx.block), blockHash: tx.blockHash };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const tx = this.txs.get(hash);
      if (!tx || tx.block === null || this.hidden.has(hash)) throw this.notFound("TransactionReceiptNotFoundError");
      return { status: "success" as const, blockNumber: BigInt(tx.block), blockHash: tx.blockHash as Hex };
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      hash: this.hashes.get(Number(blockNumber)) ?? null,
      number: blockNumber,
    }),
    getBlockNumber: async () => BigInt(this.head),
    getBalance: async () => 0n,
    readContract: async (a: any) => {
      if (a.functionName === "balanceOf") return this.bal(a.address);
      throw new Error(`unexpected read ${a.functionName}`);
    },
  };
  wallet = {
    prepareTransactionRequest: async (a: any) => ({ ...a, gas: 200_000n, maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n, type: "eip1559" }),
    sendTransaction: async (a: any) => {
      if (a.nonce < this.nonce) throw Object.assign(new Error("nonce too low"), { name: "NonceTooLowError" });
      const hash = this.h(`tx${this.n++}`);
      if (this.dropNext) {
        this.dropNext = false; // accepted, never mined, unknown to the node
        return hash;
      }
      const credit = (a.data === buyData(USDC) ? USDC : DAI) as Address;
      this.mine();
      this.txs.set(hash, { nonce: a.nonce, block: this.head, blockHash: this.hashes.get(this.head)!, to: a.to, credit, amount: 100n });
      this.nonce++;
      this.balances.set(credit.toLowerCase(), this.bal(credit) + 100n);
      if (this.hideNext) {
        this.hideNext = false;
        this.hidden.add(hash);
      }
      return hash;
    },
  };
  deps(): EvidenceDeps {
    // One empty block per poll interval (the harness's idle-block producer).
    return {
      now: () => this.t,
      sleep: async (ms) => {
        this.t += ms;
        this.mine();
      },
    };
  }
  /** Fake time passes without blocks or calls (the agent waits between calls). */
  wait(ms: number) {
    this.t += ms;
  }
}

const send = (c: Chain, tokenOut: Address, value: bigint) =>
  sendWithEvidence({
    walletClient: c.wallet,
    publicClient: c.pub as never,
    request: { account: ACCOUNT, chain: mainnet, to: ROUTER, value, data: buyData(tokenOut) },
    intent: buyIntent(tokenOut, value),
    deps: c.deps(),
  });
async function outcome(p: Promise<{ decision: string }>): Promise<string> {
  try {
    return (await p).decision;
  } catch (e) {
    if (e instanceof EvidenceError) return `${e.code}:${(e.data.evidence as any).decision}`;
    throw e;
  }
}

beforeEach(() => {
  resetEvidenceLedgers();
  process.env.EVM_EVIDENCE_LAYER = "1";
  delete process.env.EVM_EVIDENCE_ABLATE;
  delete process.env.EVM_EVIDENCE_MODE;
});
afterEach(() => {
  delete process.env.EVM_EVIDENCE_LAYER;
});

describe("TLA+ counterexamples (research/formal)", () => {
  // Trace C1 (MC_full, NoActOnOrphan): hidden receipt -> re-send gets "nonce too low" -> landed + balance effect
  // -> confirmed without ever recording receiptSeen; a later reorg orphans the swap, and because the orphan rule
  // needs receiptSeen, the guard keeps it confirmed and lets the next intent take the freed nonce.
  it.fails("C1: a reorg after a landed confirmation (receipt never visible) is detected before the next intent", async () => {
    const c = new Chain();
    c.hideNext = true;
    expect(await outcome(send(c, USDC, 10n ** 17n))).toBe("EVIDENCE_PENDING:wait_and_recheck");
    c.mine();
    expect(await outcome(send(c, USDC, 10n ** 17n))).toBe("confirmed"); // landed path, receipt still hidden
    const sale = latestIntent(1, SENDER)!;
    expect(sale.landed).toBe(true);
    expect(sale.receiptSeen).toBeNull();
    c.reorg(101); // the swap's block is replaced; the swap is gone and not re-included
    expect(c.canonical(USDC)).toBe(0);
    // The property: the guard must refuse the next intent (the earlier one is orphaned).
    const next = await outcome(send(c, DAI, 2n * 10n ** 17n));
    expect(next).toBe("EVIDENCE_UNRESOLVED:orphaned");
  });

  // Trace C2 (MC_full_shared, NoFalseConfirm): a dropped swap is graded resend_same_nonce, whose record state
  // "dropped" does not hold the guard; a different intent crediting the same token takes the pinned nonce;
  // the re-send of the first intent gets "nonce too low" -> landed, and the other intent's balance increase is
  // read as its effect -> confirmed, although it never executed.
  it.fails("C2: a dropped intent is not confirmed by another intent's execution at its nonce", async () => {
    const c = new Chain();
    c.dropNext = true;
    expect(await outcome(send(c, USDC, 10n ** 17n))).toBe("EVIDENCE_PENDING:resend_same_nonce");
    expect(latestIntent(1, SENDER)!.state).toBe("dropped");
    // A different intent (another amount, same output token) is not refused, pins nonce 7 and lands.
    expect(await outcome(send(c, USDC, 3n * 10n ** 17n))).not.toMatch(/^EVIDENCE_UNRESOLVED/);
    c.mine();
    c.wait(60_000);
    const first = await outcome(send(c, USDC, 10n ** 17n)); // re-send: "nonce too low" -> landed
    expect(c.canonical(USDC)).toBe(1); // only the other intent executed
    // The property: the first intent must not be reported confirmed.
    expect(first).not.toBe("confirmed");
  });
});
