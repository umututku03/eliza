import { expect, test } from "bun:test";
import { reconcileControlSale } from "./reconcile-control";
import { mayRestoreQueuedApproval } from "./control-child-v2";

// Recorded control-random-s19: drop, followed by critical stale=200000ms. The stock receipt wait
// returns at ~60s both times; the re-send really mined, but its balance remains stale after that wait.
function fixture({ mined = true, known = false, advanced = false } = {}) {
  let now = 60_000,
    readsAfterSend = 0,
    sends = 0,
    effectAt = Infinity,
    reports = 0;
  return {
    options: {
      seconds: 231,
      visible: async () => {
        if (sends) readsAfterSend++;
        return now >= effectAt;
      },
      mayResend: () => sends === 0,
      missing: async () => !known,
      nonceUnchanged: async () => !advanced,
      resend: async () => {
        sends++;
        effectAt = mined ? now + 200_000 : Infinity;
        now += 60_000;
      },
      sleep: async (ms: number) => {
        now += ms;
      },
      reconciled: () => {
        reports++;
      },
    },
    state: () => ({ now, sends, readsAfterSend, reports }),
  };
}
test("recorded seed 19: wait through post-resend stale window, without a duplicate", async () => {
  const f = fixture();
  await reconcileControlSale(f.options);
  expect(f.state()).toMatchObject({ sends: 1, now: 491_000, reports: 1 });
  expect(f.state().readsAfterSend).toBeGreaterThan(1);
});
for (const bad of [{ known: true }, { advanced: true }]) {
  test(`negative: do not resend without safe absence evidence ${JSON.stringify(bad)}`, async () => {
    const f = fixture(bad);
    await expect(reconcileControlSale(f.options)).rejects.toThrow(
      "Sale did not reconcile",
    );
    expect(f.state().sends).toBe(0);
    expect(f.state().reports).toBe(0);
  });
}
test("negative: still absent after the bounded retry is a failure, never completion", async () => {
  const f = fixture({ mined: false });
  await expect(reconcileControlSale(f.options)).rejects.toThrow(
    "Sale did not reconcile",
  );
  expect(f.state().sends).toBe(1);
  expect(f.state().reports).toBe(0);
});

// A1 reference failure captured in results-g1-a1-nextsend-before-1115: successful approval,
// next-send reorg, then its signed nonce+1 swap is queued while the approval effect disappears.
type ApprovalEvidence = Parameters<typeof mayRestoreQueuedApproval>[0];
function queuedApprovalEvidence(): ApprovalEvidence {
  return {
    approvalNonce: 0, canonicalNonce: 0,
    approvalAnchor: { number: 101n, hash: "0xold" },
    canonicalAnchor: { number: 101n, hash: "0xnew" },
    approvalReceiptPresent: false, allowance: 0n, amount: 50n, y: 0n, goal: 45n,
    sender: "0xsender", spender: "0xrouter", swapHash: "0xswap", swapData: "0xdata",
    queuedSwap: { hash: "0xswap", nonce: 1, from: "0xsender", to: "0xrouter", input: "0xdata", value: 0n,
      blockNumber: null, blockHash: null },
  };
}
test("A1 recorded next-send failure permits only proof-backed restoration of the original approval nonce", () => {
  expect(mayRestoreQueuedApproval(queuedApprovalEvidence())).toBe(true);
});
const unsafeApprovalRecovery: [string, (e: ApprovalEvidence) => void][] = [
  ["missing original anchor", (e) => { e.approvalAnchor = null; }],
  ["missing canonical block", (e) => { e.canonicalAnchor = null; }],
  ["original block is still canonical", (e) => { e.canonicalAnchor!.hash = "0xold"; }],
  ["block is at another height", (e) => { e.canonicalAnchor!.number = 102n; }],
  ["approval receipt still exists", (e) => { e.approvalReceiptPresent = true; }],
  ["approval nonce already consumed", (e) => { e.canonicalNonce = 1; }],
  ["allowance is already sufficient", (e) => { e.allowance = e.amount; }],
  ["goal already reached", (e) => { e.y = e.goal; }],
  ["queued transaction is unknown", (e) => { e.queuedSwap = null; }],
  ["queued transaction already mined", (e) => { e.queuedSwap!.blockNumber = 102n; e.queuedSwap!.blockHash = "0xnew"; }],
  ["queued nonce does not directly follow approval", (e) => { e.queuedSwap!.nonce = 2; }],
  ["unrelated transaction hash", (e) => { e.queuedSwap!.hash = "0xother"; }],
  ["another sender", (e) => { e.queuedSwap!.from = "0xother"; }],
  ["another spender", (e) => { e.queuedSwap!.to = "0xother"; }],
  ["different swap calldata", (e) => { e.queuedSwap!.input = "0xother"; }],
  ["unexpected native value", (e) => { e.queuedSwap!.value = 1n; }],
];
for (const [name, tamper] of unsafeApprovalRecovery) {
  test(`A1 negative: ${name} refuses approval restoration`, () => {
    const e = queuedApprovalEvidence(); tamper(e);
    expect(mayRestoreQueuedApproval(e)).toBe(false);
  });
}
