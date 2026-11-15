import { expect, test } from "bun:test";
import { reconcileControlSale } from "./reconcile-control";

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
