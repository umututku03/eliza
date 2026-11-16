/**
 * Chain-evidence layer (evidence.ts): one test per decision-table row against a fake chain with nonce semantics,
 * the flag-unset call-argument snapshots of both send sites, the re-send and guard rules, the ablations, the
 * at-most-one-canonical-per-nonce guarantee under the four chain faults, and the decoded plan refusals.
 */
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  pad,
  parseAbi,
  parseAbiParameters,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwapAction } from "../actions/swap";
import {
  CHECK_BUDGET_MS,
  checkOnce,
  classifySendError,
  DECISION_LOG_PREFIX,
  decodeRefusalSentence,
  describeCall,
  type EvidenceDeps,
  EvidenceError,
  type EvidenceIntent,
  evidenceLedger,
  evidenceSnapshot,
  intentKey,
  isUnresolved,
  latestIntent,
  quorumClient,
  resetEvidenceLedgers,
  sendWithEvidence,
} from "../evidence";
import { executeThroughPlan, type PlanGuardConfig, redeemCalldata } from "../plan-guard";

const SENDER = "0x6FF2e0DA2E0bcb67e7F5a7Cf55B2D2Fe92046aE0" as Address;
const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as Address;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
const DM = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address;
const ROUTER_ABI = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);
const SALE_WEI = 10n ** 17n;
const saleData = (deadline = 2200n) =>
  encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "swapExactETHForTokens",
    args: [1n, [WETH, USDC], SENDER, deadline],
  });
const saleIntent = (deadline = 2200n): EvidenceIntent =>
  describeCall({
    chainId: 1,
    sender: SENDER,
    holder: SENDER,
    to: ROUTER,
    value: SALE_WEI,
    data: saleData(deadline),
  });
const step2Data = encodeFunctionData({
  abi: ROUTER_ABI,
  functionName: "swapExactTokensForTokens",
  args: [60_000_000n, 1n, [USDC, WETH, DAI], SENDER, 2200n],
});
const step2Intent = (): EvidenceIntent =>
  describeCall({
    chainId: 1,
    sender: SENDER,
    holder: SENDER,
    to: ROUTER,
    value: 0n,
    data: step2Data,
  });
const ACCOUNT = { address: SENDER, type: "local" };

/** A chain with nonce semantics, automine on send, and the four fault behaviours under test control. */
class FakeChain {
  t = 0;
  head = 100;
  accountNonce = 7;
  usdc = 0n;
  dai = 0n;
  private n = 0;
  blockHashes = new Map<number, Hex>();
  txs = new Map<
    Hex,
    {
      nonce: number;
      block: number | null;
      blockHash: Hex | null;
      status: "success" | "reverted";
      sale: boolean;
    }
  >();
  hidden = new Set<Hex>();
  dropNext = false;
  hideNext = false;
  revertNext = false;
  /** rpc_stale: reads answered as of this block (receipts/tx after it unknown). */
  lagBlock: number | null = null;
  lagNonce = 0;
  lagUsdc = 0n;
  onTick: ((t: number) => void) | null = null;
  sent: any[] = [];
  waits: { hash: Hex; timeout: number }[] = [];
  simulateFail: string | null = null;
  constructor() {
    for (let b = 0; b <= this.head; b++) this.blockHashes.set(b, this.hashFor(`b${b}`));
  }
  hashFor(tag: string): Hex {
    return `0x${Buffer.from(tag).toString("hex").padEnd(64, "0").slice(0, 64)}` as Hex;
  }
  mine() {
    this.head++;
    this.blockHashes.set(this.head, this.hashFor(`b${this.head}-${this.n++}`));
  }
  /** Emulated reorg: every block from `from` replaced by an empty one, its transactions gone, state restored. */
  reorg(from: number) {
    for (const [h, tx] of [...this.txs]) {
      if (tx.block !== null && tx.block >= from) {
        this.txs.delete(h);
        this.accountNonce--;
        if (tx.status === "success" && tx.sale) this.usdc -= 100n;
      }
    }
    for (let b = from; b <= this.head; b++)
      this.blockHashes.set(b, this.hashFor(`r${b}-${this.n++}`));
  }
  canonicalByNonce() {
    const m = new Map<number, number>();
    for (const tx of this.txs.values())
      if (tx.block !== null) m.set(tx.nonce, (m.get(tx.nonce) ?? 0) + 1);
    return m;
  }
  sales() {
    return [...this.txs.values()].filter(
      (t) => t.block !== null && t.status === "success" && t.sale
    ).length;
  }
  private stale(block: number | null) {
    return this.lagBlock !== null && block !== null && block > this.lagBlock;
  }
  notFound(name: string) {
    return Object.assign(new Error(`${name}: not found`), { name });
  }
  pub = {
    getTransactionCount: async (_: { address: Address; blockTag: string }) =>
      this.lagBlock !== null ? this.lagNonce : this.accountNonce,
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const tx = this.txs.get(hash);
      if (!tx || this.stale(tx.block)) throw this.notFound("TransactionNotFoundError");
      return { blockNumber: tx.block === null ? null : BigInt(tx.block), blockHash: tx.blockHash };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const tx = this.txs.get(hash);
      if (!tx || tx.block === null || this.hidden.has(hash) || this.stale(tx.block))
        throw this.notFound("TransactionReceiptNotFoundError");
      return { status: tx.status, blockNumber: BigInt(tx.block), blockHash: tx.blockHash as Hex };
    },
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const n =
        this.lagBlock !== null && Number(blockNumber) > this.lagBlock
          ? this.lagBlock
          : Number(blockNumber);
      return { hash: this.blockHashes.get(n) ?? null, number: BigInt(n) };
    },
    getBlockNumber: async () => BigInt(this.lagBlock ?? this.head),
    getBalance: async () => 0n,
    /** Stock confirmation wait: one look, then (fake) time runs out and viem's timeout error is thrown. */
    waitForTransactionReceipt: async ({ hash, timeout }: { hash: Hex; timeout: number }) => {
      this.waits.push({ hash, timeout });
      for (let i = 0; i < 2; i++) {
        try {
          return await this.pub.getTransactionReceipt({ hash });
        } catch {}
        if (i === 0) await this.deps().sleep(timeout);
      }
      throw Object.assign(
        new Error(`Timed out while waiting for transaction with hash "${hash}" to be confirmed.`),
        {
          name: "WaitForTransactionReceiptTimeoutError",
        }
      );
    },
    /** eth_call at the head (pace_style). */
    call: vi.fn(async (_: any) => {
      if (this.simulateFail)
        throw Object.assign(new Error("execution reverted"), { details: this.simulateFail });
      return { data: "0x" };
    }),
    readContract: async (a: any) => {
      if (a.functionName === "balanceOf")
        return a.address.toLowerCase() === USDC.toLowerCase()
          ? this.lagBlock !== null
            ? this.lagUsdc
            : this.usdc
          : this.dai;
      if (a.functionName === "allowance") return 0n;
      if (a.functionName === "decimals")
        return a.address.toLowerCase() === USDC.toLowerCase() ? 6 : 18;
      if (a.functionName === "symbol")
        return a.address.toLowerCase() === USDC.toLowerCase() ? "USDC" : "DAI";
      throw new Error(`unexpected read ${a.functionName}`);
    },
  };
  wallet = {
    prepareTransactionRequest: vi.fn(async (a: any) => ({
      ...a,
      gas: 200_000n,
      maxFeePerGas: 1_000n,
      maxPriorityFeePerGas: 100n,
      type: "eip1559",
    })),
    sendTransaction: vi.fn(async (a: any) => this.submit(a)),
  };
  /** Transactions whose nonce is above the account nonce: accepted, queued behind the gap, never mined here. */
  queued: Hex[] = [];
  submit(a: any): Hex {
    this.sent.push(a);
    if (a.nonce < this.accountNonce)
      throw Object.assign(new Error("nonce too low"), { name: "NonceTooLowError" });
    // No explicit nonce (stock, verify_binary, pace_style): the sending node assigns the next one.
    a = a.nonce === undefined ? { ...a, nonce: this.accountNonce } : a;
    const hash = this.hashFor(`tx${this.n++}`);
    if (this.dropNext) {
      this.dropNext = false; // accepted, never mined, unknown to the node
      return hash;
    }
    if (a.nonce > this.accountNonce) {
      this.queued.push(hash);
      return hash;
    }
    this.mine();
    const sale = a.data === saleData() || (a.value ?? 0n) > 0n;
    const status = this.revertNext ? "reverted" : "success";
    this.revertNext = false;
    this.txs.set(hash, {
      nonce: a.nonce,
      block: this.head,
      blockHash: this.blockHashes.get(this.head)!,
      status,
      sale,
    });
    this.accountNonce++;
    if (status === "success" && sale) this.usdc += 100n;
    if (status === "success" && !sale) this.dai += 50n;
    if (this.hideNext) {
      this.hideNext = false;
      this.hidden.add(hash);
    }
    return hash;
  }
  deps(): EvidenceDeps {
    return {
      now: () => this.t,
      sleep: async (ms) => {
        this.t += ms;
        this.onTick?.(this.t);
      },
    };
  }
  /** Mines one empty block every `everyMs` of fake time. */
  tickEvery(everyMs: number) {
    let next = this.t + everyMs;
    this.onTick = (t) => {
      while (t >= next) {
        this.mine();
        next += everyMs;
      }
    };
  }
}

const send = (c: FakeChain, intent = saleIntent(), data = saleData(), value = SALE_WEI) =>
  sendWithEvidence({
    walletClient: c.wallet,
    publicClient: c.pub as never,
    request: { account: ACCOUNT, chain: mainnet, to: ROUTER, value, data },
    intent,
    deps: c.deps(),
  });
async function pending(p: Promise<unknown>): Promise<EvidenceError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EvidenceError);
    return e as EvidenceError;
  }
  throw new Error("expected an EvidenceError");
}
const ev = (e: EvidenceError) => e.data.evidence as any;

beforeEach(() => {
  resetEvidenceLedgers();
  process.env.EVM_EVIDENCE_LAYER = "1";
  delete process.env.EVM_EVIDENCE_ABLATE;
  delete process.env.EVM_EVIDENCE_MODE;
  delete process.env.EVM_PACE_POLICY;
});
afterEach(() => {
  delete process.env.EVM_EVIDENCE_LAYER;
  delete process.env.EVM_EVIDENCE_ABLATE;
  delete process.env.EVM_EVIDENCE_MODE;
  delete process.env.EVM_PACE_POLICY;
});

describe("intent key", () => {
  it("ignores slippage and deadline, distinguishes amount and direction", () => {
    expect(intentKey(saleIntent(1n))).toBe(intentKey(saleIntent(999n)));
    expect(intentKey(saleIntent())).not.toBe(intentKey(step2Intent()));
    const other = describeCall({
      chainId: 1,
      sender: SENDER,
      holder: SENDER,
      to: ROUTER,
      value: 2n * SALE_WEI,
      data: saleData(),
    });
    expect(intentKey(other)).not.toBe(intentKey(saleIntent()));
  });
});

describe("decision table (one test per row)", () => {
  it("receipt 0x1, canonical, >= K confirmations, balance effect seen -> confirmed", async () => {
    const c = new FakeChain();
    c.tickEvery(5_000);
    const r = await send(c);
    expect(r.decision).toBe("confirmed");
    expect(r.record.state).toBe("confirmed");
    expect(r.record.pinnedNonce).toBe(7);
    expect(c.wallet.sendTransaction.mock.calls[0][0].nonce).toBe(7);
  });

  it("receipt 0x1 with fewer than K confirmations -> wait", async () => {
    const c = new FakeChain(); // no new blocks: one confirmation for the whole budget
    const e = await pending(send(c));
    expect(e.code).toBe("EVIDENCE_PENDING");
    expect(ev(e).decision).toBe("wait");
    expect(ev(e).waitReason).toBe("confirmations");
    expect(e.message).toContain("has 1 of 2 confirmations");
    expect(c.t).toBeGreaterThanOrEqual(CHECK_BUDGET_MS);
  });

  it("receipt 0x0 -> failed (the caller keeps its revert error)", async () => {
    const c = new FakeChain();
    c.revertNext = true;
    const r = await send(c);
    expect(r.decision).toBe("failed");
    expect(r.record.state).toBe("failed");
  });

  it("no receipt, transaction known or nonce consumed -> wait_and_recheck", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    c.tickEvery(5_000);
    const e = await pending(send(c));
    expect(ev(e).decision).toBe("wait_and_recheck");
    expect(e.message).toContain(
      "Your swap was probably included (the account's nonce moved) but its receipt is not visible yet. Do not send it again; check its status with tx_status."
    );
  });

  it("no receipt, unknown, nonce unchanged, >= T since the send -> resend_same_nonce", async () => {
    const c = new FakeChain();
    c.dropNext = true;
    c.tickEvery(10_000); // the head advances, so this is not a stale node
    const e = await pending(send(c));
    expect(ev(e).decision).toBe("resend_same_nonce");
    expect(ev(e).state).toBe("dropped");
    expect(e.message).toContain(
      "Your swap was not found on chain and the account nonce is unchanged, so it was dropped. Repeating the same swap is safe: it reuses the same nonce, so at most one can execute."
    );
  });

  it("receipt seen, then the block at that height changed and the transaction is unknown -> orphaned", async () => {
    const c = new FakeChain();
    let reorged = false;
    c.onTick = (t) => {
      if (t >= 20_000 && !reorged) {
        reorged = true;
        c.reorg(101);
      }
    };
    const e = await pending(send(c));
    expect(ev(e).decision).toBe("orphaned");
    expect(c.t).toBeLessThan(CHECK_BUDGET_MS); // stops early
    expect(e.message).toContain(
      "Your swap was observed in block 101, but that block is no longer part of the chain (reorg). The swap is not on chain now. Repeating the same swap is safe (same nonce)."
    );
  });

  it("head not advanced for >= T while unresolved -> wait (stale node)", async () => {
    const c = new FakeChain();
    c.dropNext = true; // nothing changes, and no block is produced
    const e = await pending(send(c));
    expect(ev(e).decision).toBe("wait");
    expect(ev(e).waitReason).toBe("stale_head");
    expect(e.message).toContain(
      "Your node has not advanced for 60 s; balances read now may be out of date. Wait and check the status again before acting."
    );
  });

  it('replacement rejected with "nonce too low" -> landed, effect seen -> confirmed', async () => {
    const c = new FakeChain();
    c.hideNext = true;
    c.tickEvery(5_000);
    await pending(send(c));
    const r = await send(c, saleIntent(9999n), saleData(9999n)); // the same intent, a fresh quote and deadline
    expect(r.decision).toBe("confirmed");
    expect(r.record.landed).toBe(true);
    const [first, second] = c.sent;
    expect(second.nonce).toBe(first.nonce);
    expect(second.data).toBe(first.data); // the stored calldata, not the fresh quote
    expect(second.maxFeePerGas * 10n).toBeGreaterThanOrEqual(first.maxFeePerGas * 11n);
    expect(second.maxPriorityFeePerGas * 10n).toBeGreaterThanOrEqual(
      first.maxPriorityFeePerGas * 11n
    );
    expect(c.sales()).toBe(1);
  });

  it("landed, but the balance effect never appears -> ask_user", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    c.tickEvery(5_000);
    await pending(send(c));
    c.usdc = 0n; // the effect is not visible (for example a lagging balance read)
    const e = await pending(send(c));
    expect(ev(e).landed).toBe(true);
    expect(ev(e).decision).toBe("ask_user");
    expect(e.message).toContain("I could not confirm your swap");
  });

  it("still unresolved after N checks -> ask_user", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    const e = await pending(send(c));
    expect(ev(e).decision).toBe("wait_and_recheck");
    const r = latestIntent(1, SENDER)!;
    for (let i = 0; i < 4; i++) await checkOnce(c.pub as never, r, c.deps());
    expect(r.decision).toBe("wait_and_recheck");
    await checkOnce(c.pub as never, r, c.deps()); // sixth round
    expect(r.rounds).toBe(6);
    expect(r.decision).toBe("ask_user");
    expect(c.wallet.sendTransaction).toHaveBeenCalledTimes(1); // checks never send
  });
});

describe("evidence recovery regression cases", () => {
  it("does not confirm or release the guard when canonical block lookup fails", async () => {
    const c = new FakeChain();
    c.tickEvery(5_000);
    c.pub.getBlock = async () => {
      throw new Error("block lookup unavailable");
    };
    const e = await pending(send(c));
    expect(ev(e).decision).not.toBe("confirmed");
    expect(ev(e).observations.at(-1).canonical).toBeNull();
    expect(isUnresolved(latestIntent(1, SENDER)!)).toBe(true);
    const blocked = await pending(send(c, step2Intent(), step2Data, 0n));
    expect(blocked.code).toBe("EVIDENCE_UNRESOLVED");
    expect(c.sales()).toBe(1);
  });

  it("retains the pinned intent when broadcast succeeds but its acknowledgement is lost", async () => {
    const c = new FakeChain();
    c.tickEvery(5_000);
    c.wallet.sendTransaction.mockImplementationOnce(async (args: any) => {
      c.submit(args);
      throw new Error("connection reset after dispatch");
    });
    const e = await pending(send(c));
    expect(e.code).toBe("EVIDENCE_PENDING");
    expect(evidenceLedger(1, SENDER)).toHaveLength(1);
    expect(latestIntent(1, SENDER)!.pinnedNonce).toBe(7);
    const retry = await pending(send(c));
    expect(ev(retry).decision).toBe("ask_user");
    expect(ev(retry).landed).toBe(true);
    expect(c.sent.map((a) => a.nonce)).toEqual([7, 7]);
    expect(c.sales()).toBe(1);
  });

  it("keeps lost-acknowledgement responses binary under no_grading without inventing a hash", async () => {
    process.env.EVM_EVIDENCE_ABLATE = "no_grading";
    const c = new FakeChain();
    c.tickEvery(5_000);
    c.wallet.sendTransaction.mockImplementationOnce(async (args: any) => {
      c.submit(args);
      throw new Error("connection reset after dispatch");
    });
    const first = await pending(send(c));
    expect(first.message).toBe("Transaction failed: submission was not acknowledged.");
    const retry = await pending(send(c));
    expect(retry.message).toBe("Transaction failed: confirmation could not be established.");
    expect(retry.message).not.toContain("undefined");
    expect(c.sent.map((a) => a.nonce)).toEqual([7, 7]);
    expect(c.sales()).toBe(1);
  });

  it("serializes first-send preparation so a concurrent different intent cannot bypass the guard", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    c.wallet.prepareTransactionRequest.mockImplementationOnce(async (args: any) => {
      entered();
      await prepared;
      return {
        ...args,
        gas: 200_000n,
        maxFeePerGas: 1_000n,
        maxPriorityFeePerGas: 100n,
        type: "eip1559",
      };
    });
    const first = pending(send(c));
    await entering;
    const second = pending(send(c, step2Intent(), step2Data, 0n));
    release();
    await first;
    expect((await second).code).toBe("EVIDENCE_UNRESOLVED");
    expect(c.sent).toHaveLength(1);
  });

  it("positive reorg evidence overrides a prior nonce-too-low landed classification", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    await pending(send(c));
    c.hidden.clear();
    c.mine();
    expect((await send(c)).decision).toBe("confirmed");
    expect(latestIntent(1, SENDER)!.landed).toBe(true);
    c.reorg(101);
    const e = await pending(send(c, step2Intent(), step2Data, 0n));
    expect(e.code).toBe("EVIDENCE_UNRESOLVED");
    expect(latestIntent(1, SENDER)!.decision).toBe("orphaned");
    c.tickEvery(5_000);
    const recovered = await send(c);
    expect(recovered.record.landed).toBe(false);
    expect(recovered.record.observations.at(-1)!.confirmations).toBeGreaterThanOrEqual(2);
  });
});

describe("re-send and guard rules", () => {
  it('classifies "nonce too low" on a re-send as landed, underpriced/known as pending', () => {
    expect(classifySendError(new Error("nonce too low"))).toBe("landed");
    expect(
      classifySendError({
        name: "TransactionExecutionError",
        message: "x",
        cause: {
          name: "NonceTooLowError",
          message:
            "Nonce provided for the transaction is lower than the current nonce of the account.",
        },
      })
    ).toBe("landed");
    expect(classifySendError(new Error("replacement transaction underpriced"))).toBe("pending");
    expect(classifySendError(new Error("already known"))).toBe("pending");
    expect(classifySendError(new Error("insufficient funds"))).toBe("error");
  });

  it("refuses a different intent while one is unresolved, and allows it once resolved", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    const e = await pending(send(c));
    expect(isUnresolved(latestIntent(1, SENDER)!)).toBe(true);
    const refused = await pending(send(c, step2Intent(), step2Data, 0n));
    expect(refused.code).toBe("EVIDENCE_UNRESOLVED");
    expect(refused.message).toContain("An earlier swap is not resolved yet");
    expect(refused.message).toContain("tx_status");
    expect(c.wallet.sendTransaction).toHaveBeenCalledTimes(1);
    expect(e.code).toBe("EVIDENCE_PENDING");
    c.mine(); // the hidden sale now has K confirmations (inclusion read from eth_getTransactionByHash)
    c.tickEvery(5_000);
    const r = await send(c, step2Intent(), step2Data, 0n);
    expect(r.decision).toBe("confirmed");
    expect(c.wallet.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("re-checks a confirmed intent before another send and refuses after a reorg", async () => {
    const c = new FakeChain();
    c.tickEvery(5_000);
    expect((await send(c)).decision).toBe("confirmed");
    c.onTick = null;
    c.reorg(101);
    const refused = await pending(send(c, step2Intent(), step2Data, 0n));
    expect(refused.code).toBe("EVIDENCE_UNRESOLVED");
    expect(refused.message).toContain("no longer part of the chain (reorg)");
  });

  it("no_nonce_pin ablation re-sends with a fresh nonce", async () => {
    process.env.EVM_EVIDENCE_ABLATE = "no_nonce_pin";
    const c = new FakeChain();
    c.hideNext = true;
    c.tickEvery(5_000);
    await pending(send(c));
    await send(c);
    expect(c.sent.map((s) => s.nonce)).toEqual([7, 8]);
    expect(c.sales()).toBe(2); // the duplicate the pinned nonce prevents
  });

  it("no_grading ablation reports a binary failure", async () => {
    process.env.EVM_EVIDENCE_ABLATE = "no_grading";
    const c = new FakeChain();
    c.hideNext = true;
    const e = await pending(send(c));
    expect(e.message).toMatch(
      /^Timed out while waiting for transaction with hash "0x[0-9a-f]{64}" to be confirmed\.$/
    );
  });
});

describe("guarantee: at most one canonical transaction per (sender, pinned nonce)", () => {
  type Fault = "receipt_hidden" | "sale_dropped" | "rpc_stale" | "sale_reorged";
  /** A naive agent: whenever the sale call does not return success, it repeats the sale once. */
  async function naive(fault: Fault, ablation?: string) {
    if (ablation) process.env.EVM_EVIDENCE_ABLATE = ablation;
    resetEvidenceLedgers();
    const c = new FakeChain();
    c.tickEvery(30_000);
    if (fault === "receipt_hidden") c.hideNext = true;
    if (fault === "sale_dropped") c.dropNext = true;
    if (fault === "sale_reorged") {
      const tick = c.onTick!;
      let reorged = false;
      c.onTick = (t) => {
        if (t >= 20_000 && !reorged) {
          reorged = true;
          c.reorg(101);
        }
        tick(t);
      };
    }
    const results: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (fault === "rpc_stale" && attempt === 0) {
        // The lagging read node: armed once the sale is mined, lifted before the agent's next call.
        const submit = c.submit.bind(c);
        c.submit = (a: any) => {
          const lag = c.head;
          const h = submit(a);
          c.lagBlock = lag;
          c.lagNonce = 7;
          c.lagUsdc = 0n;
          c.submit = submit;
          return h;
        };
      }
      try {
        results.push((await send(c)).decision);
        break;
      } catch (e) {
        results.push((e as Error).message.slice(0, 40));
        c.lagBlock = null;
      }
    }
    return { c, results };
  }
  for (const fault of ["receipt_hidden", "sale_dropped", "rpc_stale", "sale_reorged"] as Fault[]) {
    it(`${fault}: no nonce carries two canonical transactions and exactly one sale executes`, async () => {
      const { c } = await naive(fault);
      expect([...c.canonicalByNonce().values()].every((n) => n <= 1)).toBe(true);
      expect(c.sales()).toBe(1);
      const r = evidenceLedger(1, SENDER)[0];
      expect(new Set(r.sentNonces)).toEqual(new Set([r.pinnedNonce]));
    });
  }
  it("without the pin (ablation) the landed cells duplicate the sale", async () => {
    expect((await naive("receipt_hidden", "no_nonce_pin")).c.sales()).toBe(2);
    expect((await naive("rpc_stale", "no_nonce_pin")).c.sales()).toBe(2);
  });
});

// ---- baselines (EVM_EVIDENCE_MODE) ------------------------------------------------------------------------
/** Result of one wallet call: the stock success hash, or the error as thrown (wording and type). */
async function outcomeOf(p: Promise<{ hash: Hex; decision: string }>) {
  try {
    const r = await p;
    return { ok: true as const, hash: r.hash, decision: r.decision, error: null as Error | null };
  } catch (e) {
    return { ok: false as const, hash: null, decision: null, error: e as Error };
  }
}
function setEvidenceMode(mode: string) {
  delete process.env.EVM_EVIDENCE_LAYER;
  process.env.EVM_EVIDENCE_MODE = mode;
}
const PACE_POLICY = {
  router: ROUTER,
  rules: [
    {
      tokenIn: "0x0000000000000000000000000000000000000000",
      tokenOut: USDC,
      maxAmountIn: SALE_WEI.toString(),
      keepAtLeastIn: null,
      minAmountOut: null,
    },
    { tokenIn: USDC, tokenOut: DAI, maxAmountIn: null, keepAtLeastIn: "50", minAmountOut: null },
  ],
};

describe("mode switch", () => {
  it("unset is off; the legacy flag is full; unknown or conflicting values are refused", async () => {
    const { evidenceMode, evidenceLayerEnabled, evidenceSendsEnabled } = await import(
      "../evidence"
    );
    delete process.env.EVM_EVIDENCE_LAYER;
    expect(evidenceMode()).toBe("off");
    expect(evidenceSendsEnabled()).toBe(false);
    process.env.EVM_EVIDENCE_LAYER = "1";
    expect(evidenceMode()).toBe("full");
    process.env.EVM_EVIDENCE_MODE = "nonce_only";
    expect(() => evidenceMode()).toThrow(/cannot be combined/);
    setEvidenceMode("verify_binary");
    expect(evidenceLayerEnabled()).toBe(false);
    expect(evidenceSendsEnabled()).toBe(true);
    setEvidenceMode("bogus");
    expect(() => evidenceMode()).toThrow(/Unknown EVM_EVIDENCE_MODE/);
  });

  it("refuses an ablation outside the full layer", async () => {
    setEvidenceMode("nonce_only");
    process.env.EVM_EVIDENCE_ABLATE = "no_grading";
    await expect(send(new FakeChain())).rejects.toThrow(/full layer only/);
  });
});

describe("nonce_only baseline", () => {
  beforeEach(() => setEvidenceMode("nonce_only"));

  it("first send pins the pending nonce; success is stock's (receipt after the stock wait)", async () => {
    const c = new FakeChain();
    const r = await send(c);
    expect(r.decision).toBe("confirmed");
    expect(c.wallet.sendTransaction.mock.calls[0][0].nonce).toBe(7);
    expect(c.waits).toEqual([{ hash: r.hash, timeout: 60_000 }]);
    expect(r.record!.baseline).toMatchObject({
      mode: "nonce_only",
      reported: "success",
      consumed: true,
      nonceGap: null,
    });
  });

  it('lost acknowledgement (receipt hidden): stock timeout, then the same-nonce re-send gets "nonce too low" -> success, no duplicate', async () => {
    const c = new FakeChain();
    c.hideNext = true;
    const first = await outcomeOf(send(c));
    expect(first.ok).toBe(false);
    expect(first.error).not.toBeInstanceOf(EvidenceError);
    expect(first.error!.message).toMatch(
      /^Timed out while waiting for transaction with hash "0x[0-9a-f]+" to be confirmed\.$/
    );
    const again = await outcomeOf(send(c, saleIntent(9_999n), saleData(9_999n)));
    expect(again.ok).toBe(true);
    const r = evidenceLedger(1, SENDER)[0];
    expect(again.hash).toBe(r.hashes[0]); // the earlier attempt, which landed
    expect(r.sentNonces).toEqual([7]);
    expect(c.sent.map((a) => a.nonce)).toEqual([7, 7]);
    expect(c.sent[1].data).toBe(saleData()); // the stored calldata, not the new call's
    expect(c.sent[1].maxFeePerGas).toBeGreaterThanOrEqual((c.sent[0].maxFeePerGas * 110n) / 100n);
    expect(c.sales()).toBe(1);
    expect(r.landed).toBe(true);
  });

  it("dropped send: the re-send reuses the pinned nonce and lands once", async () => {
    const c = new FakeChain();
    c.dropNext = true;
    expect((await outcomeOf(send(c))).ok).toBe(false);
    expect((await outcomeOf(send(c))).ok).toBe(true);
    expect(c.sent.map((a) => a.nonce)).toEqual([7, 7]);
    expect(c.sales()).toBe(1);
  });

  it("reorg: after the attempt is orphaned, a re-send with the same nonce lands once", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    let reorged = false;
    c.onTick = (t) => {
      if (t >= 20_000 && !reorged) {
        reorged = true;
        c.reorg(101);
      }
    };
    expect((await outcomeOf(send(c))).ok).toBe(false); // mined, unseen, then orphaned during the wait
    expect(c.sales()).toBe(0);
    expect((await outcomeOf(send(c))).ok).toBe(true);
    expect(c.sent.map((a) => a.nonce)).toEqual([7, 7]);
    expect(c.sales()).toBe(1);
    expect([...c.canonicalByNonce().values()].every((n) => n <= 1)).toBe(true);
  });

  it("no guard: a different intent goes ahead and takes the next free nonce; the nonce gap is recorded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = new FakeChain();
    c.dropNext = true;
    expect((await outcomeOf(send(c))).ok).toBe(false); // nonce 7 dropped, stays reserved for the sale
    const step2 = await outcomeOf(send(c, step2Intent(), step2Data, 0n));
    expect(step2.error).not.toBeInstanceOf(EvidenceError); // not EVIDENCE_UNRESOLVED: no guard
    expect(c.sent.map((a) => a.nonce)).toEqual([7, 8]);
    expect(c.queued).toHaveLength(1); // queued behind the gap at 7: real wallet behaviour
    expect(step2.error!.message).toMatch(/^Timed out while waiting/);
    const r = evidenceLedger(1, SENDER)[1];
    expect(r.baseline!.nonceGap).toEqual({ nonce: 8, pendingCount: 7, reserved: [7] });
    expect(
      warn.mock.calls.some((a) => /nonce gap: swap sent with nonce 8/.test(String(a[0])))
    ).toBe(true);
    warn.mockRestore();
  });

  it("releases the reservation once the nonce is observed consumed (no gap)", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    expect((await outcomeOf(send(c))).ok).toBe(false); // mined at 7, receipt hidden: unreported
    expect((await outcomeOf(send(c, step2Intent(), step2Data, 0n))).ok).toBe(true);
    expect(c.sent.map((a) => a.nonce)).toEqual([7, 8]);
    expect(evidenceLedger(1, SENDER)[1].baseline!.nonceGap).toBeNull();
  });

  it("a revert keeps stock's result (failed) and closes the intent", async () => {
    const c = new FakeChain();
    c.revertNext = true;
    const r = await send(c);
    expect(r.decision).toBe("failed");
    expect(r.record!.baseline!.reported).toBe("failed");
  });
});

describe("verify_binary baseline", () => {
  beforeEach(() => setEvidenceMode("verify_binary"));

  it("sends exactly the stock request (no pinned nonce) and waits as stock does", async () => {
    const c = new FakeChain();
    const r = await send(c);
    expect(r.decision).toBe("confirmed");
    expect(c.wallet.sendTransaction.mock.calls[0][0]).toEqual({
      account: ACCOUNT,
      chain: mainnet,
      to: ROUTER,
      value: SALE_WEI,
      data: saleData(),
    });
    expect(c.wallet.prepareTransactionRequest).not.toHaveBeenCalled();
    expect(c.waits).toEqual([{ hash: r.hash, timeout: 60_000 }]);
  });

  it("complete by balance effect (receipt hidden): success, not sent again", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    expect((await outcomeOf(send(c))).ok).toBe(false);
    const again = await outcomeOf(send(c));
    expect(again.ok).toBe(true);
    expect(c.sent).toHaveLength(1);
    expect(evidenceLedger(1, SENDER)[0].baseline!.checks.map((x) => [x.result, x.reason])).toEqual([
      ["complete", "balance effect visible"],
    ]);
  });

  it("complete by receipt (status 1)", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    expect((await outcomeOf(send(c))).ok).toBe(false);
    c.hidden.clear();
    c.usdc = 0n; // no balance evidence: the receipt alone decides
    expect((await outcomeOf(send(c))).ok).toBe(true);
    expect(c.sent).toHaveLength(1);
    expect(evidenceLedger(1, SENDER)[0].baseline!.checks[0].reason).toBe("receipt with status 1");
  });

  it("incomplete (dropped): re-sends with a fresh nonce, as stock would", async () => {
    const c = new FakeChain();
    c.dropNext = true;
    expect((await outcomeOf(send(c))).ok).toBe(false);
    expect((await outcomeOf(send(c))).ok).toBe(true);
    expect(c.sent.map((a) => a.nonce)).toEqual([undefined, undefined]);
    expect("nonce" in c.wallet.sendTransaction.mock.calls[1][0]).toBe(false);
    expect(c.sales()).toBe(1);
    expect(evidenceLedger(1, SENDER)[0].baseline!.checks[0]).toMatchObject({
      result: "incomplete",
      reason: "no receipt and no balance effect",
    });
  });

  it("an inconclusive read counts as incomplete", async () => {
    const c = new FakeChain();
    c.hideNext = true;
    expect((await outcomeOf(send(c))).ok).toBe(false);
    const read = c.pub.readContract;
    c.pub.readContract = async () => {
      throw new Error("upstream timeout");
    };
    expect((await outcomeOf(send(c))).ok).toBe(true);
    c.pub.readContract = read;
    expect(evidenceLedger(1, SENDER)[0].baseline!.checks[0]).toMatchObject({
      result: "incomplete",
      reason: "inconclusive: the balance read failed",
    });
    expect(c.sales()).toBe(2); // the landed sale is repeated: the binary design's false incomplete
  });

  it("a stale read node with a fresh sending node: incomplete, so the landed sale is duplicated (expected by design)", async () => {
    const c = new FakeChain();
    const submit = c.submit.bind(c);
    c.submit = (a: any) => {
      const lag = c.head;
      const h = submit(a);
      c.lagBlock = lag; // reads lag behind the sale's block
      c.lagUsdc = 0n;
      c.submit = submit;
      return h;
    };
    expect((await outcomeOf(send(c))).ok).toBe(false);
    // Only reads are stale: sends reach a node that assigns the true next nonce.
    expect((await outcomeOf(send(c))).ok).toBe(false); // its receipt is stale too
    expect(c.sales()).toBe(2);
    expect(evidenceLedger(1, SENDER)[0].baseline!.checks[0].result).toBe("incomplete");
  });
});

describe("pace_style baseline", () => {
  beforeEach(() => {
    setEvidenceMode("pace_style");
    process.env.EVM_PACE_POLICY = JSON.stringify(PACE_POLICY);
  });

  it("approves a declared call, simulates it at the head, then sends and waits exactly as stock", async () => {
    const c = new FakeChain();
    const r = await send(c);
    expect(r.decision).toBe("confirmed");
    expect(r.record).toBeNull();
    expect(c.pub.call).toHaveBeenCalledWith({
      account: ACCOUNT,
      to: ROUTER,
      data: saleData(),
      value: SALE_WEI,
    });
    expect(c.wallet.sendTransaction.mock.calls[0][0]).toEqual({
      account: ACCOUNT,
      chain: mainnet,
      to: ROUTER,
      value: SALE_WEI,
      data: saleData(),
    });
    expect(evidenceLedger(1, SENDER)).toHaveLength(0); // stateless
  });

  it("a simulation failure is a refusal (nothing is sent)", async () => {
    const c = new FakeChain();
    c.simulateFail = "UniswapV2Router: EXPIRED";
    await expect(send(c)).rejects.toThrow(
      /^Refused by the pre-signing check: the simulation at the head failed \(UniswapV2Router: EXPIRED\)\.$/
    );
    expect(c.sent).toHaveLength(0);
  });

  it("a duplicate intent is approved: each call is checked independently", async () => {
    const c = new FakeChain();
    await send(c);
    await send(c);
    expect(c.sales()).toBe(2);
    expect(c.sent.map((a) => a.nonce)).toEqual([undefined, undefined]);
  });

  it("policy: undeclared router, pair, amount above the maximum, reserve breach and no minimum output are refused", async () => {
    const c = new FakeChain();
    const refuse = (data: Hex, value: bigint, to: Address = ROUTER) =>
      sendWithEvidence({
        walletClient: c.wallet,
        publicClient: c.pub as never,
        request: { account: ACCOUNT, chain: mainnet, to, value, data },
        intent: describeCall({ chainId: 1, sender: SENDER, holder: SENDER, to, value, data }),
        deps: c.deps(),
      });
    await expect(refuse(saleData(), SALE_WEI, DAI)).rejects.toThrow(/is not the declared router/);
    await expect(refuse(saleData(), 2n * SALE_WEI)).rejects.toThrow(/exceeds the declared maximum/);
    const toDai = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [1n, [WETH, DAI], SENDER, 2200n],
    });
    await expect(refuse(toDai, SALE_WEI)).rejects.toThrow(/is not declared/);
    const noMin = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "swapExactETHForTokens",
      args: [0n, [WETH, USDC], SENDER, 2200n],
    });
    await expect(refuse(noMin, SALE_WEI)).rejects.toThrow(/sets no minimum output/);
    c.usdc = 60n; // the step spends 60_000_000 base units while 50 must stay
    await expect(refuse(step2Data, 0n)).rejects.toThrow(/would leave less than the declared/);
    expect(c.sent).toHaveLength(0);
  });
});

// ---- flag unset: byte-for-byte the current path -----------------------------------------------------------
function fakeProvider(wallet: any, pub: any) {
  return {
    chains: { mainnet },
    getWalletClient: () => wallet,
    getPublicClient: () => pub,
    getChainConfigs: () => mainnet,
  } as any;
}

describe("flag unset: send sites call viem exactly as before", () => {
  it("swap.ts Uniswap V2 send: sendTransaction and waitForTransactionReceipt arguments (snapshot)", async () => {
    delete process.env.EVM_EVIDENCE_LAYER;
    delete process.env.EVM_EVIDENCE_MODE;
    const wallet = {
      account: ACCOUNT,
      chain: mainnet,
      getAddresses: vi.fn(async () => [SENDER]),
      sendTransaction: vi.fn(async () => `0x${"ab".repeat(32)}`),
      prepareTransactionRequest: vi.fn(),
    };
    const pub = {
      readContract: vi.fn(async (a: any) =>
        a.functionName === "WETH" ? WETH : [SALE_WEI, 237_636_476n]
      ),
      getBlock: vi.fn(async () => ({ timestamp: 1_000n })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
      getTransactionCount: vi.fn(),
    };
    const action = new SwapAction(fakeProvider(wallet, pub), {
      uniswapV2Router: ROUTER,
      exclusive: true,
    });
    await action.swap({
      chain: "mainnet",
      fromToken: "0x0000000000000000000000000000000000000000",
      toToken: USDC,
      amount: "0.1",
      slippageBps: 300,
    } as any);
    const minOut = (237_636_476n * 9_700n) / 10_000n;
    expect(wallet.sendTransaction.mock.calls).toEqual([
      [
        {
          account: ACCOUNT,
          to: ROUTER,
          value: SALE_WEI,
          data: encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: "swapExactETHForTokens",
            args: [minOut, [WETH, USDC], SENDER, 2_200n],
          }),
          chain: mainnet,
        },
      ],
    ]);
    expect(Object.keys(wallet.sendTransaction.mock.calls[0][0] as object)).toEqual([
      "account",
      "to",
      "value",
      "data",
      "chain",
    ]);
    expect(pub.waitForTransactionReceipt.mock.calls).toEqual([
      [{ hash: `0x${"ab".repeat(32)}`, timeout: 60_000 }],
    ]);
    expect(wallet.prepareTransactionRequest).not.toHaveBeenCalled();
    expect(pub.getTransactionCount).not.toHaveBeenCalled();
  });

  it("plan-guard.ts redemption send: arguments (snapshot) and the raw refusal text", async () => {
    delete process.env.EVM_EVIDENCE_LAYER;
    delete process.env.EVM_EVIDENCE_MODE;
    const wallet = {
      account: ACCOUNT,
      chain: mainnet,
      sendTransaction: vi.fn(async () => `0x${"cd".repeat(32)}`),
      prepareTransactionRequest: vi.fn(),
    };
    const pub = {
      call: vi.fn(async () => ({})),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    };
    const plan: PlanGuardConfig = {
      account: SENDER,
      delegationManager: DM,
      steps: [],
      approvals: [],
    };
    const ctx = permissionContext([]);
    const call = { to: ROUTER, value: SALE_WEI, data: saleData() };
    await executeThroughPlan(
      fakeProvider(wallet, pub),
      "mainnet" as never,
      plan,
      [ctx],
      call,
      "swap"
    );
    expect(wallet.sendTransaction.mock.calls).toEqual([
      [{ account: ACCOUNT, chain: mainnet, to: DM, data: redeemCalldata(ctx, call), value: 0n }],
    ]);
    expect(pub.waitForTransactionReceipt.mock.calls).toEqual([
      [{ hash: `0x${"cd".repeat(32)}`, timeout: 60_000 }],
    ]);
    pub.call.mockRejectedValueOnce(
      new Error("execution reverted: ERC20BalanceChangeEnforcer:exceeded-balance-decrease")
    );
    await expect(
      executeThroughPlan(
        fakeProvider(wallet, pub),
        "mainnet" as never,
        plan,
        [ctx],
        call,
        "swap 60 X -> Y"
      )
    ).rejects.toThrow(
      /^Refused by the approved plan \(ERC20BalanceChangeEnforcer:exceeded-balance-decrease\): swap 60 X -> Y$/
    );
  });
});

// ---- patient (EVM_EVIDENCE_MODE=patient): the stock path with only the receipt-wait timeout extended ------------
describe("patient: the stock send path, only the receipt-wait timeout differs", () => {
  /** Every call made on the wallet and public clients, in order, by one stock-path swap and one plan redemption. */
  async function stockTrace(mode: string | null) {
    delete process.env.EVM_EVIDENCE_LAYER;
    if (mode === null) delete process.env.EVM_EVIDENCE_MODE;
    else process.env.EVM_EVIDENCE_MODE = mode;
    const log: unknown[] = [];
    const rec = (who: string, f: (...a: any[]) => any) =>
      vi.fn(async (...a: any[]) => {
        log.push([who, ...a]);
        return f(...a);
      });
    const wallet = {
      account: ACCOUNT,
      chain: mainnet,
      getAddresses: rec("wallet.getAddresses", () => [SENDER]),
      sendTransaction: rec("wallet.sendTransaction", () => `0x${"ab".repeat(32)}`),
      prepareTransactionRequest: rec("wallet.prepareTransactionRequest", () => ({})),
    };
    const pub = {
      readContract: rec("pub.readContract", (a: any) => (a.functionName === "WETH" ? WETH : [SALE_WEI, 237_636_476n])),
      getBlock: rec("pub.getBlock", () => ({ timestamp: 1_000n })),
      waitForTransactionReceipt: rec("pub.waitForTransactionReceipt", () => ({ status: "success" })),
      getTransactionCount: rec("pub.getTransactionCount", () => 7n),
      call: rec("pub.call", () => ({})),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new SwapAction(fakeProvider(wallet, pub), { uniswapV2Router: ROUTER, exclusive: true }).swap({
      chain: "mainnet",
      fromToken: "0x0000000000000000000000000000000000000000",
      toToken: USDC,
      amount: "0.1",
      slippageBps: 300,
    } as any);
    const plan: PlanGuardConfig = { account: SENDER, delegationManager: DM, steps: [], approvals: [] };
    await executeThroughPlan(fakeProvider(wallet, pub), "mainnet" as never, plan, [permissionContext([])], { to: ROUTER, value: SALE_WEI, data: saleData() }, "swap");
    const warned = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("[evidence]"));
    warn.mockRestore();
    return { log, warned, wallet, pub };
  }

  it("unset: 60 s waits and no mode line; patient: identical calls except timeout 300 s, and the mode line", async () => {
    const { PATIENT_RECEIPT_TIMEOUT_MS, TX_CONFIRMATION_TIMEOUT_MS } = await import("../constants");
    expect(TX_CONFIRMATION_TIMEOUT_MS).toBe(60_000);
    expect(PATIENT_RECEIPT_TIMEOUT_MS).toBe(300_000);
    const stock = await stockTrace(null);
    const patient = await stockTrace("patient");
    expect(stock.warned).toEqual([]);
    expect(patient.warned).toEqual(["[evidence] EVM_EVIDENCE_MODE=patient"]);
    const waits = (t: typeof stock) => t.log.filter((c: any) => c[0] === "pub.waitForTransactionReceipt");
    expect(waits(stock).map((c: any) => c[1].timeout)).toEqual([60_000, 60_000]);
    expect(waits(patient).map((c: any) => c[1].timeout)).toEqual([300_000, 300_000]);
    const normalised = JSON.stringify(
      patient.log,
      (_k, v) => (typeof v === "bigint" ? `${v}n` : v)
    ).replaceAll('"timeout":300000', '"timeout":60000');
    expect(normalised).toBe(JSON.stringify(stock.log, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
    // No ledger, no pinned nonce, no extra reads: the evidence path is never entered.
    for (const t of [stock, patient]) {
      expect(t.wallet.prepareTransactionRequest).not.toHaveBeenCalled();
      expect(t.pub.getTransactionCount).not.toHaveBeenCalled();
    }
  });

  it("patient is a stock-path mode: evidence sends stay off and sendWithEvidence refuses it", async () => {
    const { evidenceMode, evidenceLayerEnabled, evidenceSendsEnabled, receiptTimeoutMs } = await import("../evidence");
    setEvidenceMode("patient");
    expect(evidenceMode()).toBe("patient");
    expect(evidenceSendsEnabled()).toBe(false);
    expect(evidenceLayerEnabled()).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(receiptTimeoutMs()).toBe(300_000);
    warn.mockRestore();
    await expect(send(new FakeChain())).rejects.toThrow(/stock-path mode/);
    process.env.EVM_EVIDENCE_LAYER = "1";
    expect(() => evidenceMode()).toThrow(/cannot be combined/);
    delete process.env.EVM_EVIDENCE_LAYER;
    delete process.env.EVM_EVIDENCE_MODE;
    expect(receiptTimeoutMs()).toBe(60_000);
  });
});

describe("baselines that send as stock: swap.ts hands viem the stock arguments", () => {
  for (const mode of ["verify_binary", "pace_style"]) {
    it(`${mode}: sendTransaction and waitForTransactionReceipt arguments equal the flag-unset snapshot`, async () => {
      setEvidenceMode(mode);
      process.env.EVM_PACE_POLICY = JSON.stringify(PACE_POLICY);
      const wallet = {
        account: ACCOUNT,
        chain: mainnet,
        getAddresses: vi.fn(async () => [SENDER]),
        sendTransaction: vi.fn(async () => `0x${"ab".repeat(32)}`),
        prepareTransactionRequest: vi.fn(),
      };
      const pub = {
        readContract: vi.fn(async (a: any) =>
          a.functionName === "WETH"
            ? WETH
            : a.functionName === "balanceOf"
              ? 0n
              : [SALE_WEI, 237_636_476n]
        ),
        getBlock: vi.fn(async () => ({ timestamp: 1_000n })),
        waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
        getTransactionCount: vi.fn(),
        call: vi.fn(async () => ({ data: "0x" })),
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const action = new SwapAction(fakeProvider(wallet, pub), {
        uniswapV2Router: ROUTER,
        exclusive: true,
      });
      await action.swap({
        chain: "mainnet",
        fromToken: "0x0000000000000000000000000000000000000000",
        toToken: USDC,
        amount: "0.1",
        slippageBps: 300,
      } as any);
      expect(warn).toHaveBeenCalledWith(`[evidence] EVM_EVIDENCE_MODE=${mode}`);
      warn.mockRestore();
      const minOut = (237_636_476n * 9_700n) / 10_000n;
      const data = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "swapExactETHForTokens",
        args: [minOut, [WETH, USDC], SENDER, 2_200n],
      });
      expect(wallet.sendTransaction.mock.calls).toEqual([
        [{ account: ACCOUNT, to: ROUTER, value: SALE_WEI, data, chain: mainnet }],
      ]);
      expect(Object.keys(wallet.sendTransaction.mock.calls[0][0] as object)).toEqual([
        "account",
        "to",
        "value",
        "data",
        "chain",
      ]);
      expect(pub.waitForTransactionReceipt.mock.calls).toEqual([
        [{ hash: `0x${"ab".repeat(32)}`, timeout: 60_000 }],
      ]);
      expect(wallet.prepareTransactionRequest).not.toHaveBeenCalled();
      expect(pub.getTransactionCount).not.toHaveBeenCalled();
      expect(pub.call).toHaveBeenCalledTimes(mode === "pace_style" ? 1 : 0);
    });
  }
});

// ---- actionable refusals ---------------------------------------------------------------------------------
const DELEGATIONS = parseAbiParameters(
  "(address,address,bytes32,(address,bytes,bytes)[],uint256,bytes)[]"
);
function permissionContext(terms: Hex[]): Hex {
  const caveats = terms.map((t) => [DM, t, "0x"] as const);
  return encodeAbiParameters(DELEGATIONS, [
    [[SENDER, SENDER, `0x${"ff".repeat(32)}`, caveats, 1n, "0x"]],
  ] as never);
}
const balanceChange = (decrease: boolean, token: Address, amount: bigint) =>
  `0x${decrease ? "01" : "00"}${token.slice(2)}${SENDER.slice(2)}${pad(`0x${amount.toString(16)}`, { size: 32 }).slice(2)}` as Hex;
const floor = (token: Address, amount: bigint) =>
  `0x${token.slice(2)}${pad(`0x${amount.toString(16)}`, { size: 32 }).slice(2)}` as Hex;
const calldataIs = (start: number, value: bigint) =>
  `0x${pad(`0x${start.toString(16)}`, { size: 32 }).slice(2)}${pad(`0x${value.toString(16)}`, { size: 32 }).slice(2)}` as Hex;

describe("refusals the agent can act on", () => {
  const c = new FakeChain();
  const step2 = { to: ROUTER, value: 0n, data: step2Data }; // asks for 60 USDC
  it("decodes ERC20BalanceChangeEnforcer bounds", async () => {
    const ctx = permissionContext([
      calldataIs(100, 1n),
      balanceChange(true, USDC, 59_406_476n),
      balanceChange(false, DAI, 37_310_000_000_000_000_000n),
    ]);
    expect(
      await decodeRefusalSentence(
        c.pub as never,
        ctx,
        "ERC20BalanceChangeEnforcer:exceeded-balance-decrease",
        step2
      )
    ).toBe("This step may spend at most 59.406476 USDC; you asked for 60 USDC.");
    expect(
      await decodeRefusalSentence(
        c.pub as never,
        ctx,
        "ERC20BalanceChangeEnforcer:insufficient-balance-increase",
        step2
      )
    ).toBe("This step must yield at least 37.31 DAI.");
  });
  it("decodes AllowedCalldataEnforcer, BalanceFloorEnforcer and PlanStepEnforcer", async () => {
    const ctx = permissionContext([
      calldataIs(100, BigInt(SENDER)),
      calldataIs(4, 59_406_476n),
      floor(USDC, 178_230_000n),
      floor(DAI, 37_310_000_000_000_000_000n),
    ]);
    expect(
      await decodeRefusalSentence(
        c.pub as never,
        ctx,
        "AllowedCalldataEnforcer:invalid-calldata",
        step2
      )
    ).toBe("This step only accepts amount 59.406476 USDC.");
    expect(
      await decodeRefusalSentence(c.pub as never, ctx, "BalanceFloorEnforcer:below-floor", step2)
    ).toBe(
      "After this step the account must still hold at least 178.23 USDC and at least 37.31 DAI."
    );
    expect(
      await decodeRefusalSentence(
        c.pub as never,
        ctx,
        "PlanStepEnforcer:step-already-completed",
        step2
      )
    ).toBe("This step is not allowed now: prerequisite not done, or already done.");
  });
  it("appends the sentence to the unchanged refusal prefix when the layer is on", async () => {
    const wallet = {
      account: ACCOUNT,
      chain: mainnet,
      sendTransaction: vi.fn(),
      prepareTransactionRequest: vi.fn(),
    };
    const pub = {
      ...c.pub,
      call: vi.fn(async () =>
        Promise.reject(new Error("reverted: ERC20BalanceChangeEnforcer:exceeded-balance-decrease"))
      ),
    };
    const plan: PlanGuardConfig = {
      account: SENDER,
      delegationManager: DM,
      steps: [],
      approvals: [],
    };
    const ctx = permissionContext([balanceChange(true, USDC, 59_406_476n)]);
    await expect(
      executeThroughPlan(
        fakeProvider(wallet, pub),
        "mainnet" as never,
        plan,
        [ctx],
        step2,
        "swap 60 X -> Y"
      )
    ).rejects.toThrow(
      "Refused by the approved plan (ERC20BalanceChangeEnforcer:exceeded-balance-decrease): swap 60 X -> Y. This step may spend at most 59.406476 USDC; you asked for 60 USDC."
    );
    process.env.EVM_EVIDENCE_ABLATE = "no_refusal_decode";
    await expect(
      executeThroughPlan(
        fakeProvider(wallet, pub),
        "mainnet" as never,
        plan,
        [ctx],
        step2,
        "swap 60 X -> Y"
      )
    ).rejects.toThrow(
      /^Refused by the approved plan \(ERC20BalanceChangeEnforcer:exceeded-balance-decrease\): swap 60 X -> Y$/
    );
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("decision log (EVM_EVIDENCE_DECISION_LOG=1): logging only", () => {
  const json = (v: unknown) =>
    JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  /** Every full-layer site that returns a decision: send (confirmed, wait, wait_and_recheck, stale head),
   *  a guard refusal, tx_status checks, and an unacknowledged send. Returns everything the agent and viem see. */
  async function scenarios(): Promise<string> {
    const out: unknown[] = [];
    const capture = async (p: Promise<any>) => {
      try {
        const r = await p;
        out.push({ decision: r.decision, hash: r.hash, record: evidenceSnapshot(r.record) });
      } catch (e) {
        out.push({
          message: (e as Error).message,
          code: (e as EvidenceError).code,
          evidence: (e as EvidenceError).data?.evidence,
        });
      }
    };
    resetEvidenceLedgers();
    let c = new FakeChain();
    c.tickEvery(5_000);
    await capture(send(c)); // confirmed
    out.push(c.sent);
    resetEvidenceLedgers();
    c = new FakeChain();
    await capture(send(c)); // wait (1 of 2 confirmations)
    await capture(send(c, step2Intent(), step2Data, 0n)); // guard refusal
    const r = latestIntent(1, SENDER)!;
    await checkOnce(c.pub as never, r, c.deps()); // tx_status: still waiting
    c.mine();
    await checkOnce(c.pub as never, r, c.deps()); // tx_status: confirmed
    await checkOnce(c.pub as never, r, c.deps()); // tx_status on a confirmed intent
    out.push(evidenceSnapshot(r), c.sent);
    resetEvidenceLedgers();
    c = new FakeChain();
    c.hideNext = true;
    c.tickEvery(5_000);
    await capture(send(c)); // wait_and_recheck
    resetEvidenceLedgers();
    c = new FakeChain();
    c.dropNext = true;
    await capture(send(c)); // stale head
    resetEvidenceLedgers();
    c = new FakeChain();
    c.wallet.sendTransaction.mockRejectedValueOnce(new Error("socket hang up"));
    await capture(send(c)); // unacknowledged
    out.push(c.sent);
    return json(out);
  }
  const logged = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map((a) => String(a[0])).filter((l) => l.startsWith(DECISION_LOG_PREFIX));
  afterEach(() => {
    delete process.env.EVM_EVIDENCE_DECISION_LOG;
    vi.restoreAllMocks();
  });

  it("flag unset: nothing is written, and the flag changes no result, message, record or viem argument", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const unset = await scenarios();
    expect(spy).not.toHaveBeenCalled();
    process.env.EVM_EVIDENCE_DECISION_LOG = "1";
    const set = await scenarios();
    expect(set).toBe(unset);
    expect(logged(spy).length).toBeGreaterThan(0);
  });

  it("flag set: one line per returned decision, with its site and chain observations, and no request or signer", async () => {
    process.env.EVM_EVIDENCE_DECISION_LOG = "1";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await scenarios();
    const lines = logged(spy).map((l) => JSON.parse(l.slice(DECISION_LOG_PREFIX.length)));
    expect(lines.map((l) => [l.site, l.decision, l.waitReason])).toEqual([
      ["send", "confirmed", null],
      ["send", "wait", "confirmations"],
      ["guard", "wait", "confirmations"],
      ["check", "wait", "confirmations"],
      ["check", "confirmed", null],
      ["check", "confirmed", null],
      ["send", "wait_and_recheck", null],
      ["send", "wait", "stale_head"],
      ["send_unacknowledged", "wait", "not_seen"],
    ]);
    const wait = lines[1];
    expect(wait).toMatchObject({
      v: 1,
      label: "swap",
      chainId: 1,
      sender: SENDER,
      pinnedNonce: 7,
      observations: expect.any(Number),
    });
    expect(wait.key).toBe(intentKey(saleIntent()));
    expect(wait.hashes).toHaveLength(1);
    expect(wait.lastObservation).toMatchObject({
      head: 101,
      receiptBlock: 101,
      receiptStatus: "success",
      canonical: true,
      confirmations: 1,
    });
    expect(typeof wait.atMs).toBe("number");
    expect(lines[8].hashes).toEqual([]);
    expect(lines[8].lastObservation).toBeNull();
    for (const l of lines)
      for (const k of ["request", "account", "message", "snapshot"])
        expect(l).not.toHaveProperty(k);
  });
});

// ---- byte-identity of the full layer (WS-Q) ------------------------------------------------------------------
/** Every call the layer makes on the read client and the wallet, in order, JSON-safe. */
function traced<T extends Record<string, any>>(obj: T, log: unknown[], prefix: string): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj))
    out[k] =
      typeof v === "function"
        ? async (...args: any[]) => {
            const {
              account: _a,
              chain: _c,
              abi: _abi,
              ...rest
            } = (args[0] ?? {}) as Record<string, unknown>;
            log.push(
              `${prefix}.${k} ${JSON.stringify(rest, (_, x) => (typeof x === "bigint" ? `${x}n` : x))}`
            );
            return v(...args);
          }
        : v;
  return out as T;
}
type NaiveFault = "none" | "receipt_hidden" | "sale_dropped" | "rpc_stale" | "sale_reorged";
/** The naive-agent run of the guarantee tests (repeat the sale once after a non-success), through `pubFor(c)`. */
async function naiveTrace(fault: NaiveFault, pubFor: (c: FakeChain) => unknown = (c) => c.pub) {
  resetEvidenceLedgers();
  const c = new FakeChain();
  c.tickEvery(30_000);
  if (fault === "receipt_hidden") c.hideNext = true;
  if (fault === "sale_dropped") c.dropNext = true;
  if (fault === "sale_reorged") {
    const tick = c.onTick!;
    let reorged = false;
    c.onTick = (t) => {
      if (t >= 20_000 && !reorged) {
        reorged = true;
        c.reorg(101);
      }
      tick(t);
    };
  }
  const log: unknown[] = [];
  const pub = traced(pubFor(c) as Record<string, any>, log, "pub");
  const wallet = traced(c.wallet as Record<string, any>, log, "wallet");
  const results: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (fault === "rpc_stale" && attempt === 0) {
      const submit = c.submit.bind(c);
      c.submit = (a: any) => {
        const lag = c.head;
        const h = submit(a);
        c.lagBlock = lag;
        c.lagNonce = 7;
        c.lagUsdc = 0n;
        c.submit = submit;
        return h;
      };
    }
    try {
      const r = await sendWithEvidence({
        walletClient: wallet as never,
        publicClient: pub as never,
        request: {
          account: ACCOUNT,
          chain: mainnet,
          to: ROUTER,
          value: SALE_WEI,
          data: saleData(),
        },
        intent: saleIntent(),
        deps: c.deps(),
      });
      results.push({ ok: r.decision, hash: r.hash });
      break;
    } catch (e) {
      results.push({ error: (e as Error).message, code: (e as EvidenceError).code });
      c.lagBlock = null;
    }
  }
  // One JSON line per record (observations included), so the snapshot stays compact.
  const ledger = evidenceLedger(1, SENDER).map((r) =>
    JSON.stringify(r, (k, x) =>
      k === "account" || k === "chain" ? undefined : typeof x === "bigint" ? `${x}n` : x
    )
  );
  return { calls: log, results, ledger, sales: c.sales(), t: c.t };
}

describe("full layer: byte-identical traces (snapshot taken before full_quorum existed)", () => {
  for (const fault of [
    "none",
    "receipt_hidden",
    "sale_dropped",
    "rpc_stale",
    "sale_reorged",
  ] as NaiveFault[]) {
    it(`${fault}: read/write calls, results and ledger`, async () => {
      expect(await naiveTrace(fault)).toMatchSnapshot();
    });
  }
});

// ---- full_quorum (WS-Q): quorum reads inside the evidence layer ---------------------------------------------
/** What one read endpoint shows of the fake chain: honest, frozen at a block (stale), lying, on another fork, or down. */
interface EndpointFaults {
  /** Frozen view: head, nonce and USDC balance as of `block`; later receipts and transactions unknown. */
  stale?: { block: number; nonce: number; usdc: bigint } | null;
  /** Claims a success receipt (and a mined transaction) in the current head block for these hashes. */
  lieAbout?: Set<Hex>;
  /** Reports different block hashes from `fromBlock` on (another fork). */
  fork?: { fromBlock: number };
  down?: boolean;
}
function endpoint(c: FakeChain, f: EndpointFaults = {}) {
  const lag = () => f.stale?.block ?? null;
  const hide = (block: number | null) => block !== null && lag() !== null && block > lag()!;
  const hashAt = (n: number) =>
    f.fork && n >= f.fork.fromBlock ? c.hashFor(`fork${n}`) : (c.blockHashes.get(n) ?? null);
  const up = () => {
    if (f.down) throw new Error("fetch failed: connection refused");
  };
  return {
    getBlockNumber: async () => (up(), BigInt(lag() ?? c.head)),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      up();
      const n = lag() !== null && Number(blockNumber) > lag()! ? lag()! : Number(blockNumber);
      return { hash: hashAt(n), number: BigInt(n) };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      up();
      if (f.lieAbout?.has(hash))
        return {
          status: "success" as const,
          blockNumber: BigInt(c.head),
          blockHash: hashAt(c.head)!,
        };
      const tx = c.txs.get(hash);
      if (!tx || tx.block === null || c.hidden.has(hash) || hide(tx.block))
        throw c.notFound("TransactionReceiptNotFoundError");
      return { status: tx.status, blockNumber: BigInt(tx.block), blockHash: hashAt(tx.block)! };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      up();
      if (f.lieAbout?.has(hash)) return { blockNumber: BigInt(c.head), blockHash: hashAt(c.head) };
      const tx = c.txs.get(hash);
      if (!tx || hide(tx.block)) throw c.notFound("TransactionNotFoundError");
      return {
        blockNumber: tx.block === null ? null : BigInt(tx.block),
        blockHash: tx.block === null ? null : hashAt(tx.block),
      };
    },
    getTransactionCount: async (_: {
      address: Address;
      blockTag?: string;
      blockNumber?: bigint;
    }) => (up(), f.stale ? f.stale.nonce : c.accountNonce),
    getBalance: async () => (up(), 0n),
    readContract: async (a: any) => {
      up();
      if (a.functionName === "balanceOf")
        return a.address.toLowerCase() === USDC.toLowerCase()
          ? f.stale
            ? f.stale.usdc
            : c.usdc
          : c.dai;
      if (a.functionName === "allowance") return 0n;
      throw new Error(`unexpected read ${a.functionName}`);
    },
  };
}
const quorumOf = (c: FakeChain, ...faults: EndpointFaults[]) =>
  quorumClient(
    faults.map((f, i) => ({ role: `read${i}`, client: endpoint(c, f) as never })),
    { stallMs: 1_000 }
  );
const sendVia = (c: FakeChain, pub: unknown) =>
  sendWithEvidence({
    walletClient: c.wallet,
    publicClient: pub as never,
    request: { account: ACCOUNT, chain: mainnet, to: ROUTER, value: SALE_WEI, data: saleData() },
    intent: saleIntent(),
    deps: c.deps(),
  });
/** The naive agent (repeat the sale once after a non-success) through a quorum client. */
async function naiveQuorum(c: FakeChain, pub: unknown) {
  const results: { ok?: string; message?: string; evidence?: any }[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      results.push({ ok: (await sendVia(c, pub)).decision });
      break;
    } catch (e) {
      results.push({
        message: (e as Error).message,
        evidence: (e as EvidenceError).data?.evidence,
      });
    }
  }
  return results;
}
const lastQuorum = () => {
  const r = evidenceLedger(1, SENDER)[0];
  return r.observations[r.observations.length - 1].quorum!;
};

describe("full_quorum: mode switch and configuration", () => {
  it("is the full layer (guard, tx_status, refusal decoding) and needs at least two read endpoints", async () => {
    const { evidenceMode, evidenceLayerEnabled, evidenceSendsEnabled, evidenceReadClient } =
      await import("../evidence");
    setEvidenceMode("full_quorum");
    expect(evidenceMode()).toBe("full_quorum");
    expect(evidenceLayerEnabled()).toBe(true);
    expect(evidenceSendsEnabled()).toBe(true);
    process.env.EVM_EVIDENCE_READ_URLS = "http://127.0.0.1:1";
    expect(() => evidenceReadClient(new FakeChain().pub as never)).toThrow(/at least 2 endpoints/);
    process.env.EVM_EVIDENCE_READ_URLS = "http://127.0.0.1:1,http://127.0.0.1:2";
    process.env.EVM_EVIDENCE_READ_ROLES = "primary,secondary";
    const q = evidenceReadClient(new FakeChain().pub as never) as any;
    expect(q.quorumEndpoints.map((e: any) => e.role)).toEqual(["primary", "secondary"]);
    process.env.EVM_EVIDENCE_LAYER = "1";
    expect(() => evidenceMode()).toThrow(/cannot be combined/);
    delete process.env.EVM_EVIDENCE_READ_URLS;
    delete process.env.EVM_EVIDENCE_READ_ROLES;
    expect(() => quorumClient([{ role: "only", client: new FakeChain().pub as never }])).toThrow(
      /at least 2/
    );
  });

  it("full mode ignores the read-endpoint list: traces are identical with it set", async () => {
    for (const fault of ["none", "rpc_stale", "sale_reorged"] as NaiveFault[]) {
      delete process.env.EVM_EVIDENCE_READ_URLS;
      const plain = await naiveTrace(fault);
      process.env.EVM_EVIDENCE_READ_URLS = "http://127.0.0.1:1,http://127.0.0.1:2";
      const withList = await naiveTrace(fault);
      delete process.env.EVM_EVIDENCE_READ_URLS;
      expect(withList).toEqual(plain);
    }
  });
});

describe("full_quorum: agreement rule", () => {
  beforeEach(() => setEvidenceMode("full_quorum"));

  it("honest endpoints agree: the same decisions and messages as the full layer", async () => {
    for (const fault of [
      "none",
      "receipt_hidden",
      "sale_dropped",
      "sale_reorged",
    ] as NaiveFault[]) {
      setEvidenceMode("full_quorum");
      const q = await naiveTrace(fault, (c) => quorumOf(c, {}, {}));
      setEvidenceMode("full");
      process.env.EVM_EVIDENCE_LAYER = "1";
      const f = await naiveTrace(fault);
      delete process.env.EVM_EVIDENCE_LAYER;
      expect(q.results).toEqual(f.results);
      expect(q.sales).toBe(f.sales);
    }
  });

  it("one lagging (stale) endpoint is outvoted by height: the advanced consistent view confirms the sale", async () => {
    const c = new FakeChain();
    c.tickEvery(30_000);
    const stale: EndpointFaults = { stale: null };
    // Armed when the sale mines, as the harness's rpc_stale proxy does: frozen one block before the sale.
    const submit = c.submit.bind(c);
    c.submit = (a: any) => {
      const h = submit(a);
      stale.stale = { block: c.head - 1, nonce: 7, usdc: 0n };
      c.submit = submit;
      return h;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await naiveQuorum(c, quorumOf(c, stale, {}));
    expect(results).toEqual([{ ok: "confirmed" }]);
    expect(c.sales()).toBe(1);
    const q = lastQuorum();
    expect(q).toMatchObject({
      ok: true,
      chosen: "read1",
      members: ["read0", "read1"],
      lagging: ["read0"],
      quorum: 2,
    });
    expect(q.heads[0]).toBe(100);
    expect(q.heads[1]).toBeGreaterThanOrEqual(102);
    expect(
      warn.mock.calls.some((a) =>
        /\[evidence\] quorum agreed: chosen read1.*lagging \(stale\): read0/.test(String(a[0]))
      )
    ).toBe(true);
    warn.mockRestore();
  });

  it("an endpoint within the lag tolerance is not reported as lagging", async () => {
    const c = new FakeChain();
    c.tickEvery(30_000);
    const behind: EndpointFaults = { stale: null };
    const submit = c.submit.bind(c);
    c.submit = (a: any) => {
      const h = submit(a);
      c.submit = submit;
      return h;
    };
    // One block behind at every read: inside the default tolerance of 1.
    const ep = endpoint(c, behind);
    const lagged = { ...ep, getBlockNumber: async () => BigInt(c.head - 1) };
    const pub = quorumClient(
      [
        { role: "read0", client: lagged as never },
        { role: "read1", client: endpoint(c) as never },
      ],
      { stallMs: 1_000 }
    );
    expect(await naiveQuorum(c, pub)).toEqual([{ ok: "confirmed" }]);
    expect(lastQuorum().lagging).toEqual([]);
  });

  it("a lagging endpoint that is not a prefix of the advanced view breaks the quorum (N = 2)", async () => {
    const c = new FakeChain();
    c.tickEvery(30_000);
    const pub = quorumOf(c, {}, {});
    await sendVia(c, pub).catch(() => {});
    resetEvidenceLedgers();
    // read0 sits on another fork from block 95 on: its head block's hash is not in read1's chain.
    const forked = quorumOf(
      c,
      { fork: { fromBlock: 95 }, stale: { block: c.head - 1, nonce: 8, usdc: 100n } },
      {}
    );
    const e: any = await sendVia(c, forked).then(
      () => null,
      (x) => x
    );
    expect(e?.code).toBe("NETWORK_ERROR");
    expect(e.message).toMatch(/different blocks at the same height/);
  });

  it("no quorum (endpoints on different forks) => wait, and ask_user after N rounds; nothing re-sent", async () => {
    const c = new FakeChain();
    c.tickEvery(30_000);
    const fork: EndpointFaults = {};
    const submit = c.submit.bind(c);
    c.submit = (a: any) => {
      const h = submit(a);
      fork.fork = { fromBlock: c.head }; // read0 shows another block at the sale's height from now on
      c.submit = submit;
      return h;
    };
    const pub = quorumOf(c, fork, {});
    const e = await pending(sendVia(c, pub));
    expect(ev(e).decision).toBe("wait");
    expect(ev(e).waitReason).toBe("no_quorum");
    expect(e.message).toMatch(
      /RPC endpoints disagree about the chain \(the endpoints report different blocks at the same height\)/
    );
    expect(e.message).toMatch(/Do not send it again/);
    const r = evidenceLedger(1, SENDER)[0];
    for (let i = 0; i < 5; i++) await checkOnce(pub, r, c.deps());
    expect(r.decision).toBe("ask_user");
    expect(c.wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("an endpoint that does not answer: no quorum with N = 2, quorum with N = 3", async () => {
    const c2 = new FakeChain();
    c2.tickEvery(30_000);
    const e: any = await sendVia(c2, quorumOf(c2, {}, { down: true })).then(
      () => null,
      (x) => x
    );
    expect(e?.code).toBe("NETWORK_ERROR");
    expect(e.message).toMatch(/Nothing was sent: .*1 of 2 endpoints did not answer/);
    expect(c2.wallet.sendTransaction).not.toHaveBeenCalled();
    resetEvidenceLedgers();
    const c3 = new FakeChain();
    c3.tickEvery(30_000);
    expect((await sendVia(c3, quorumOf(c3, {}, { down: true }, {}))).decision).toBe("confirmed");
    expect(lastQuorum()).toMatchObject({ ok: true, members: ["read0", "read2"], quorum: 2 });
  });

  it("an endpoint stalled past the stall timeout abstains", async () => {
    vi.useFakeTimers();
    try {
      const c = new FakeChain();
      const slow = { ...endpoint(c), getBlockNumber: () => new Promise<bigint>(() => {}) };
      const pub = quorumClient(
        [
          { role: "read0", client: slow as never },
          { role: "read1", client: endpoint(c) as never },
        ],
        { stallMs: 1_000 }
      );
      const p = pub.getTransactionCount({ address: SENDER, blockTag: "pending" });
      const settled = expect(p).rejects.toThrow(/1 of 2 endpoints did not answer/);
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("full_quorum: a lying endpoint (success receipt where the others find nothing)", () => {
  beforeEach(() => setEvidenceMode("full_quorum"));

  it("N = 2: the tie leaves the receipt unresolved => wait (no confirmation, no 'dropped'); the same-nonce repeat lands once", async () => {
    const c = new FakeChain();
    c.tickEvery(30_000);
    c.dropNext = true;
    const liar: EndpointFaults = { lieAbout: new Set() };
    const send = c.wallet.sendTransaction;
    c.wallet.sendTransaction = vi.fn(async (a: any) => {
      const h = await send(a);
      if (liar.lieAbout!.size === 0) liar.lieAbout!.add(h);
      return h;
    });
    const results = await naiveQuorum(c, quorumOf(c, liar, {}));
    expect(results[0].evidence.decision).toBe("wait");
    expect(results[0].evidence.waitReason).toBe("no_quorum");
    expect(results[0].message).toMatch(/no majority on the swap's receipt or inclusion/);
    expect(results[0].message).not.toMatch(/dropped|confirmed/);
    expect(results[1]).toEqual({ ok: "confirmed" });
    expect(c.sales()).toBe(1);
    expect([...c.canonicalByNonce().values()].every((n) => n <= 1)).toBe(true);
    const r = evidenceLedger(1, SENDER)[0];
    expect(new Set(r.sentNonces)).toEqual(new Set([r.pinnedNonce]));
    expect(lastQuorum().disagreements).toContain("receipt");
  });

  it("N = 3: the liar is outvoted; the layer sees what the honest majority sees (dropped => same-nonce re-send)", async () => {
    const c = new FakeChain();
    c.tickEvery(30_000);
    c.dropNext = true;
    const liar: EndpointFaults = { lieAbout: new Set() };
    const send = c.wallet.sendTransaction;
    c.wallet.sendTransaction = vi.fn(async (a: any) => {
      const h = await send(a);
      if (liar.lieAbout!.size === 0) liar.lieAbout!.add(h);
      return h;
    });
    const results = await naiveQuorum(c, quorumOf(c, liar, {}, {}));
    expect(results[0].evidence.decision).toBe("resend_same_nonce");
    expect(results[1]).toEqual({ ok: "confirmed" });
    expect(c.sales()).toBe(1);
  });

  it("the full layer on the lying endpoint alone would confirm a transaction that never landed (the case quorum reads cover)", async () => {
    setEvidenceMode("full");
    process.env.EVM_EVIDENCE_LAYER = "1";
    const c = new FakeChain();
    c.tickEvery(30_000);
    c.dropNext = true;
    const liar: EndpointFaults = { lieAbout: new Set() };
    const send = c.wallet.sendTransaction;
    c.wallet.sendTransaction = vi.fn(async (a: any) => {
      const h = await send(a);
      liar.lieAbout!.add(h);
      return h;
    });
    // The lie covers the receipt only; the balance effect never appears, so even the single-node layer does not
    // report confirmed, but it does report the swap as included (and never dropped).
    const e = await pending(sendVia(c, endpoint(c, liar)));
    expect(ev(e).state).toBe("included");
    expect(c.sales()).toBe(0);
  });
});

describe("full_quorum: preflight state and abstention safety", () => {
  beforeEach(() => setEvidenceMode("full_quorum"));
  const clients = (...xs: any[]) =>
    quorumClient(
      xs.map((client, i) => ({ role: `read${i}`, client })),
      { stallMs: 1000 }
    );

  it("same-head nonce disagreement prevents the first send", async () => {
    const c = new FakeChain();
    c.tickEvery(5000);
    const q = clients({ ...endpoint(c), getTransactionCount: async () => 9 }, endpoint(c));
    await expect(sendVia(c, q)).rejects.toThrow(/Nothing was sent.*nonce/);
    expect(c.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("same-head balance disagreement cannot be swallowed as an unknown snapshot before sending", async () => {
    const c = new FakeChain();
    c.tickEvery(5000);
    const q = clients({ ...endpoint(c), readContract: async () => 999n }, endpoint(c));
    await expect(sendVia(c, q)).rejects.toThrow(/Nothing was sent.*balance/);
    expect(c.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it.each(["nonce", "balance"])(
    "an abstention on %s counts against the eligible preflight quorum",
    async (fact) => {
      const c = new FakeChain();
      c.tickEvery(5000);
      const other = endpoint(c);
      const down = async () => {
        throw new Error("state endpoint unavailable");
      };
      const q = clients(
        endpoint(c),
        fact === "nonce"
          ? { ...other, getTransactionCount: down }
          : { ...other, readContract: down }
      );
      await expect(sendVia(c, q)).rejects.toThrow(/Nothing was sent/);
      expect(c.wallet.sendTransaction).not.toHaveBeenCalled();
    }
  );

  it("one receipt supporter plus one abstention is not a receipt majority", async () => {
    const c = new FakeChain();
    c.tickEvery(5000);
    const q = clients(endpoint(c), {
      ...endpoint(c),
      getTransactionReceipt: async () => {
        throw new Error("receipt endpoint unavailable");
      },
    });
    const e = await pending(sendVia(c, q));
    expect(ev(e).waitReason).toBe("no_quorum");
    expect(c.sales()).toBe(1);
  });

  it("a prior confirmation becomes pending when the providers no longer form a quorum", async () => {
    const c = new FakeChain();
    c.tickEvery(5000);
    const fault: EndpointFaults = {};
    const q = clients(endpoint(c), endpoint(c, fault));
    expect((await sendVia(c, q)).decision).toBe("confirmed");
    const record = latestIntent(1, SENDER)!;
    fault.fork = { fromBlock: c.head };
    await checkOnce(q, record, c.deps());
    expect(record.decision).toBe("wait");
    expect(record.waitReason).toBe("no_quorum");
    delete fault.fork;
    expect((await sendVia(c, q)).decision).toBe("confirmed");
    expect(c.sales()).toBe(1);
  });

  it("two agreeing providers outvote the first provider's bad nonce without blocking valid progress", async () => {
    const c = new FakeChain();
    c.tickEvery(5000);
    const q = clients(
      { ...endpoint(c), getTransactionCount: async () => 9 },
      endpoint(c),
      endpoint(c)
    );
    expect((await sendVia(c, q)).decision).toBe("confirmed");
    expect(c.sent[0].nonce).toBe(7);
    expect(c.sales()).toBe(1);
  });
  it("all receipt RPC abstentions are uncertainty, not agreement that a receipt is absent", async () => {
    const c = new FakeChain();
    c.tickEvery(5000);
    const noReceipt = () => ({
      ...endpoint(c),
      getTransactionReceipt: async () => {
        throw new Error("receipt RPC unavailable");
      },
    });
    const e = await pending(sendVia(c, clients(noReceipt(), noReceipt())));
    expect(ev(e).waitReason).toBe("no_quorum");
  });
});
