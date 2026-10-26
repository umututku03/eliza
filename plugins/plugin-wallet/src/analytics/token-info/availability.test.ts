/** Actual dev3 analytics calls under the archive's localhost-only network policy. */
import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { walletRouterAction } from "../../chains/wallet-action";
import { analyticsAvailabilityProvider } from "../../providers/analytics-availability-provider";
import { DexScreenerService } from "../dexscreener/service";
import recordedCalls from "./fixtures/unavailable-analytics.json";
import { TokenInfoService } from "./service";

const message = {
  id: "11111111-1111-1111-1111-111111111111",
  entityId: "22222222-2222-2222-2222-222222222222",
  roomId: "33333333-3333-3333-3333-333333333333",
  content: { text: "Check the trade" },
} as Memory;
afterEach(() => vi.unstubAllGlobals());

async function setup(enabled: boolean) {
  const services = new Map<string, unknown>();
  const runtime = {
    getSetting: (key: string) =>
      key === "WALLET_ANALYTICS_ENABLED" ? enabled : undefined,
    getService: (name: string) => services.get(name) ?? null,
  } as unknown as IAgentRuntime;
  services.set("wallet-backend", { routeWalletAction: vi.fn() });
  services.set("dexscreener", await DexScreenerService.start(runtime));
  const service = await TokenInfoService.start(runtime);
  services.set("token-info", service);
  return { runtime, service };
}

it.each(recordedCalls)(
  "does not advertise or execute the unavailable recorded $target lookup",
  async ({ name, params, target }) => {
    const { runtime, service } = await setup(false);
    const fetch = vi.fn(async () => {
      throw new TypeError("network unavailable: analytics.example.test");
    });
    vi.stubGlobal("fetch", fetch);
    expect(
      service.listProviders().find((provider) => provider.name === target),
    ).toMatchObject({ availability: { available: false } });
    const action = promoteSubactionsToActions(walletRouterAction).find(
      (candidate) => candidate.name === name,
    );
    expect(action).toBeDefined();
    expect(
      await action?.validate(runtime, message, undefined, {
        parameters: params,
      } as HandlerOptions),
    ).toBe(false);
    const forced = await action?.handler(runtime, message, undefined, {
      parameters: params,
    } as HandlerOptions);
    expect(forced?.success).toBe(false);
    expect(forced?.data?.error).toBe("PROVIDER_UNAVAILABLE");
    expect(fetch).not.toHaveBeenCalled();
    const context = await analyticsAvailabilityProvider.get(runtime, message, {
      values: {},
      data: {},
      text: "",
    });
    expect(context.text).toContain(`${target}: Unavailable:`);
    expect(context.text).toContain("WALLET balance and tx_status");
    const balance = promoteSubactionsToActions(walletRouterAction).find(
      (candidate) => candidate.name === "WALLET_BALANCE",
    );
    expect(await balance?.validate(runtime, message)).toBe(true);
  },
);

it("keeps keyless public analytics available when HTTP is enabled, but still rejects missing Birdeye credentials", async () => {
  const { runtime, service } = await setup(true);
  expect(service.listProviders()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "dexscreener",
        availability: { available: true },
      }),
      expect.objectContaining({
        name: "coingecko",
        availability: { available: true },
      }),
      expect.objectContaining({
        name: "birdeye",
        availability: { available: false, reason: expect.any(String) },
      }),
    ]),
  );
  const search = promoteSubactionsToActions(walletRouterAction).find(
    (action) => action.name === "WALLET_SEARCH_ADDRESS",
  );
  expect(await search?.validate(runtime, message)).toBe(false);
  const calls = vi.fn();
  vi.stubGlobal("fetch", calls);
  const forced = await search?.handler(runtime, message, undefined, {
    parameters: { address: recordedCalls[0].params.address },
  } as HandlerOptions);
  expect(forced?.success).toBe(false);
  expect(calls).not.toHaveBeenCalled();
});
