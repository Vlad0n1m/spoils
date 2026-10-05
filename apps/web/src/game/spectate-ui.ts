/**
 * Small pure helpers of the spectate UI (components/spectate-replay.tsx, the outcome overlay).
 */

import type { SpectateEndReason } from "@extract/shared";

/** The key after `current` in the mates list (wraps), or the first one. */
export function nextMateKey(mates: ReadonlyArray<{ key: string }>, current: string | null): string | null {
  if (mates.length === 0) return null;
  const i = current ? mates.findIndex((m) => m.key === current) : -1;
  return mates[(i + 1) % mates.length]!.key;
}

/** One line for the outcome screen after a watch ended without the player asking. */
export function spectateEndedLine(e: { reason: SpectateEndReason; name: string } | null): string | null {
  if (!e) return null;
  const who = e.name || "Your mate";
  switch (e.reason) {
    case "mate_down":
      return `${who} is down.`;
    case "mate_out":
      return `${who} got out.`;
    case "wipe":
      return "The map wiped.";
    case "refused":
      return `Can't watch ${e.name || "that mate"} right now.`;
    default:
      return null;
  }
}
