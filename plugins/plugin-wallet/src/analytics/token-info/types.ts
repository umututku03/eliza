/** Shared contracts between `TokenInfoService`, its providers, and the `token_info` action handler. */
import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

export const TOKEN_INFO_SUBACTIONS = [
  "search",
  "token",
  "trending",
  "new_pairs",
  "chain_pairs",
  "boosted",
  "profiles",
  "wallet",
] as const;

export type TokenInfoSubaction = (typeof TOKEN_INFO_SUBACTIONS)[number];
export type TokenInfoAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface TokenInfoParams {
  readonly target?: string;
  readonly subaction: TokenInfoSubaction;
  readonly query?: string;
  readonly address?: string;
  readonly tokenAddress?: string;
  readonly chain?: string;
  readonly timeframe?: "1h" | "6h" | "24h";
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: "volume" | "liquidity" | "priceChange" | "txns";
  readonly top?: boolean;
  readonly kind?: "wallet-address" | "token-address" | "token-symbol";
  readonly id?: string;
}

export interface TokenInfoProviderMetadata {
  readonly availability?: TokenInfoAvailability;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly supportedSubactions: readonly TokenInfoSubaction[];
  readonly description?: string;
}

export interface TokenInfoProvider extends TokenInfoProviderMetadata {
  getAvailability?(runtime: IAgentRuntime): TokenInfoAvailability;
  execute(context: TokenInfoDispatchContext): Promise<ActionResult>;
}

export interface TokenInfoDispatchContext {
  readonly runtime: IAgentRuntime;
  readonly message: Memory;
  readonly state?: State;
  readonly options?: HandlerOptions | Record<string, unknown>;
  readonly params: TokenInfoParams;
  readonly callback?: HandlerCallback;
}

export type TokenInfoRouteResult =
  | {
      readonly ok: true;
      readonly provider: TokenInfoProviderMetadata;
      readonly result: ActionResult;
    }
  | {
      readonly ok: false;
      readonly error:
        | "UNSUPPORTED_PROVIDER"
        | "PROVIDER_UNAVAILABLE"
        | "UNSUPPORTED_SUBACTION"
        | "INVALID_PARAMS"
        | "EXECUTION_FAILED";
      readonly detail: string;
      readonly providers?: readonly TokenInfoProviderMetadata[];
    };
