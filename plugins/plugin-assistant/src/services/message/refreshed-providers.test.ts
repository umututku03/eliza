import { describe, expect, it } from "vitest";
import { financialHoldingIsUngrounded } from "./financial-observations";
import { mergeRefreshedProviders } from "./refreshed-providers";

const wallet = (usdc: string) => ({
  text: "",
  values: {},
  data: {
    holdings: [
      {
        chain: "mainnet",
        symbol: "ETH",
        amount: usdc === "0" ? "1" : "0.899863606673511392",
      },
      { chain: "mainnet", symbol: "USDC", amount: usdc },
    ],
  },
});

describe("refreshed providers for reply grounding", () => {
  it("replaces only the refreshed entries", () => {
    const other = { text: "kept", values: {}, data: {} };
    const merged = mergeRefreshedProviders(
      { "evm-wallet": wallet("0"), RECENT_MESSAGES: other },
      {
        "evm-wallet": wallet("237.636476"),
        RECENT_MESSAGES: { text: "new", values: {}, data: {} },
      },
      ["evm-wallet"],
    );
    expect(merged?.["evm-wallet"]).toEqual(wallet("237.636476"));
    expect(merged?.RECENT_MESSAGES).toBe(other);
    expect(
      mergeRefreshedProviders({ a: other }, { a: wallet("1") }, null),
    ).toEqual({ a: other });
  });

  it("lets a truthful post-trade holding ground after the sale", () => {
    // Live check, claude-haiku-5-5: the recovery evidence still showed the pre-sale wallet.
    const reply = "Your wallet now holds 237.64 USDC.";
    const stale = { "evm-wallet": wallet("0") };
    expect(
      financialHoldingIsUngrounded({
        reply,
        actionResults: [],
        providers: stale,
      }),
    ).toBe(true);
    const merged = mergeRefreshedProviders(
      stale,
      { "evm-wallet": wallet("237.636476") },
      ["evm-wallet"],
    );
    expect(
      financialHoldingIsUngrounded({
        reply,
        actionResults: [],
        providers: merged,
      }),
    ).toBe(false);
  });
});
