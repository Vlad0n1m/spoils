/** GET / POST /api/seeker (lib/seeker/seeker.ts). */
export interface SeekerDto {
  /** The linked wallet (lib/wallet), null when none is linked. */
  wallet: string | null;
  /** The wallet held a Seeker Genesis Token at the last check. */
  verified: boolean;
  /** That SGT's mint address. */
  mint: string | null;
  /** ISO time of the last mainnet check of this wallet, null if never checked. */
  checkedAt: string | null;
  /** The account owns the Seeker frame. */
  claimed: boolean;
  /** Verified, not claimed, and this SGT has not claimed for another account. */
  claimable: boolean;
  /** Cosmetic id of the one-time reward (@extract/shared SEEKER_FRAME). */
  reward: string;
  /** The last mainnet check failed; the fields above are the previous answer (if any). */
  unavailable: boolean;
}
