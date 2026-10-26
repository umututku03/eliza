import { describe, expect, it } from "vitest";
import {
  financialHoldingIsUngrounded,
  financialObservationProviders,
} from "./financial-observations";

// Replies recorded on a pinned mainnet fork (claude-haiku-5-5, a two-step swap task).
const REQUEST =
  "Sell exactly 0.1 ETH for USDC (token 0xA0b8…eB48) from my wallet on Ethereum mainnet. Then acquire at least 37.31 DAI (token 0x6B17…1d0F) while keeping at least 178.23 USDC in my wallet.";
const CAUTIOUS_REPLY =
  "I submitted the swap of 0.1 ETH to USDC (transaction 0x91a6), but I have not confirmed that it went through or how much USDC arrived. I did not buy any DAI, and I have not verified that the 178.23 USDC minimum is still met. Once the services are reachable again, I can check the transaction and balances and then attempt the DAI purchase while keeping at least 178.23 USDC in your wallet.";
const BALANCE_REPLY =
  "The DAI purchase has not been attempted. The last balance check showed 0 DAI and 237.64 USDC.";

const evmWallet = (holdings: Array<{ symbol: string; amount: string }>) => ({
  "evm-wallet": {
    text: "",
    values: {},
    data: {
      address: "0x6FF2e0DA2E0bcb67e7F5a7Cf55B2D2Fe92046aE0",
      holdings: holdings.map((h) => ({ chain: "mainnet", ...h })),
    },
  },
});

describe("financial holdings grounding", () => {
  it("does not read a restated limit as a wallet holding", () => {
    expect(
      financialHoldingIsUngrounded({
        reply: CAUTIOUS_REPLY,
        request: REQUEST,
        actionResults: [],
        providers: {},
      }),
    ).toBe(false);
  });

  it("does not read a traded amount as a wallet holding", () => {
    expect(
      financialHoldingIsUngrounded({
        reply:
          "I submitted the 0.1 ETH to USDC swap from your wallet on Ethereum mainnet, transaction 0x91a6. I haven't confirmed that it settled.",
        request: REQUEST,
        actionResults: [],
        providers: {},
      }),
    ).toBe(false);
  });

  it("does not read hypothetical or order amounts as holdings", () => {
    // claude-haiku-5-5 drafts rejected in the live check (calls 37 and 61).
    for (const reply of [
      "If you want me to continue, I can try a smaller USDC amount that should yield about 37 DAI while keeping at least 178.23 USDC in the wallet.",
      "I got a fresh quote for buying DAI with 38 USDC from your wallet. It should return about 37.77 DAI.",
    ]) {
      expect(
        financialHoldingIsUngrounded({
          reply,
          request: "Yes, confirm.",
          actionResults: [],
          providers: {},
        }),
      ).toBe(false);
    }
    // Stated holdings are still checked, including "left with".
    for (const reply of [
      "Your wallet is left with 999 USDC.",
      "Your wallet now holds 999 USDC.",
    ]) {
      expect(
        financialHoldingIsUngrounded({
          reply,
          request: "Yes, confirm.",
          actionResults: [],
          providers: {},
        }),
      ).toBe(true);
    }
  });

  it("grounds EVM wallet holdings in the evm-wallet provider", () => {
    const providers = evmWallet([
      { symbol: "ETH", amount: "0.899" },
      { symbol: "USDC", amount: "237.636476" },
      { symbol: "DAI", amount: "0" },
    ]);
    expect(financialObservationProviders(providers)).toHaveProperty(
      "evm-wallet",
    );
    expect(
      financialHoldingIsUngrounded({
        reply: BALANCE_REPLY,
        request: REQUEST,
        actionResults: [],
        providers,
      }),
    ).toBe(false);
  });

  it("still rejects an EVM holding the wallet does not show", () => {
    for (const usdc of ["237.65", "237.63", "240"]) {
      expect(
        financialHoldingIsUngrounded({
          reply: `The last balance check showed 0 DAI and ${usdc} USDC.`,
          request: REQUEST,
          actionResults: [],
          providers: evmWallet([
            { symbol: "USDC", amount: "237.636476" },
            { symbol: "DAI", amount: "0" },
          ]),
        }),
      ).toBe(true);
    }
  });

  it("grounds a personal holding in this turn's on-chain balance read", () => {
    const balance = (scope: string) => ({
      success: true,
      text: "",
      data: {
        actionName: "WALLET_BALANCE",
        subaction: "balance",
        scope,
        holdings: [{ chain: "mainnet", symbol: "USDC", amount: "237.636476" }],
      },
    });
    const reply = "Your wallet now holds 237.64 USDC.";
    expect(
      financialHoldingIsUngrounded({
        reply,
        request: REQUEST,
        actionResults: [balance("configured_wallet")],
        providers: {},
      }),
    ).toBe(false);
    // A read that is not of the configured wallet does not prove ownership.
    expect(
      financialHoldingIsUngrounded({
        reply,
        request: REQUEST,
        actionResults: [balance("other")],
        providers: {},
      }),
    ).toBe(true);
  });

  it("still rejects an EVM holding with no wallet observation", () => {
    expect(
      financialHoldingIsUngrounded({
        reply: BALANCE_REPLY,
        request: REQUEST,
        actionResults: [],
        providers: {},
      }),
    ).toBe(true);
  });
});
