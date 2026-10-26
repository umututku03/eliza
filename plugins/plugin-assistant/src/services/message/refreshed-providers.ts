/**
 * Reply grounding reads the turn state's provider observations. When a
 * confirmed write refreshes named providers for the planner, the same entries
 * must refresh there too, or a truthful post-trade reply is judged against the
 * pre-trade wallet (live check: "0 USDC" as evidence right after the sale).
 */
import type { StateData } from "@elizaos/core";

export function mergeRefreshedProviders(
  current: StateData["providers"],
  fresh: StateData["providers"],
  names: readonly string[] | null | undefined,
): StateData["providers"] {
  if (!names || names.length === 0 || !fresh) return current;
  const refreshed = Object.fromEntries(
    names.filter((name) => name in fresh).map((name) => [name, fresh[name]]),
  );
  return Object.keys(refreshed).length > 0
    ? { ...(current ?? {}), ...refreshed }
    : current;
}
