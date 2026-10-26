/** Configuration readiness only: never probes a network or claims verified connectivity. */
import { resolveCloudRoute } from "@elizaos/cloud-routing";
import type { IAgentRuntime } from "@elizaos/core";
import { BIRDEYE_ROUTE_SPEC } from "../birdeye/service";
import { toWalletCloudRoutingSettings } from "../cloud-routing-authority";
import type { TokenInfoAvailability } from "./types";

export function analyticsNetworkAvailability(
  runtime: IAgentRuntime,
): TokenInfoAvailability {
  const enabled = runtime.getSetting("WALLET_ANALYTICS_ENABLED");
  return enabled === false || String(enabled).trim().toLowerCase() === "false"
    ? {
        available: false,
        reason: "External HTTP wallet analytics are disabled by configuration.",
      }
    : { available: true };
}

export function birdeyeAvailability(
  runtime: IAgentRuntime,
): TokenInfoAvailability {
  const network = analyticsNetworkAvailability(runtime);
  if (!network.available) return network;
  return resolveCloudRoute(
    toWalletCloudRoutingSettings(runtime),
    BIRDEYE_ROUTE_SPEC,
  ).source === "disabled"
    ? {
        available: false,
        reason:
          "Birdeye requires a configured credential or Eliza Cloud route.",
      }
    : { available: true };
}
