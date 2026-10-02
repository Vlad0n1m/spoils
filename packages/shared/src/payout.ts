import { MASS_UNITS_PER_CENT, PAYOUT } from "./constants.js";

export function payoutMultiplier(exitOrder: number, totalExtracted: number): number {
  if (totalExtracted <= 0 || exitOrder < 1 || exitOrder > totalExtracted) return 0;
  if (totalExtracted === 1) return PAYOUT.FIRST_OUT_MULT;
  const t = (exitOrder - 1) / (totalExtracted - 1);
  return PAYOUT.FIRST_OUT_MULT + t * (PAYOUT.LAST_OUT_MULT - PAYOUT.FIRST_OUT_MULT);
}

export function applyMultiplier(massUnits: bigint, mult: number): bigint {
  if (mult <= 0) return 0n;
  return (massUnits * BigInt(Math.round(mult * 10_000))) / 10_000n;
}

export function massUnitsToCents(mass: bigint): bigint {
  return mass / MASS_UNITS_PER_CENT;
}
