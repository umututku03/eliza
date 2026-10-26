/** Truthful analytics readiness in planner context; no credential values or network probes. */
import type { Provider } from "@elizaos/core";
import {
  TOKEN_INFO_SERVICE_TYPE,
  type TokenInfoService,
} from "../analytics/token-info/service";

export const analyticsAvailabilityProvider: Provider = {
  name: "wallet-analytics-availability",
  description: "Readiness and dependencies of external wallet analytics.",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "OWNER" },
  cacheStable: false,
  cacheScope: "turn",
  dynamic: true,
  get: async (runtime) => {
    const service = runtime.getService(
      TOKEN_INFO_SERVICE_TYPE,
    ) as TokenInfoService | null;
    const providers = service?.listProviders?.() ?? [];
    return {
      text: [
        "## External Wallet Analytics",
        ...(providers.length
          ? providers.map(
              (provider) =>
                `${provider.name}: ${provider.availability?.available === false ? `Unavailable: ${provider.availability.reason}` : "configured; requires HTTP connectivity (not verified)."}`,
            )
          : ["Unavailable: token analytics service is not running."]),
        "Scope: token_info and Birdeye search_address only. WALLET balance and tx_status read the configured chain RPC and do not require these analytics services.",
      ].join("\n"),
    };
  },
};
