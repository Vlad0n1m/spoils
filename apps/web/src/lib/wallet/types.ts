/** Client-safe shapes of the /api/wallet/link routes. */

/** GET /api/wallet/link and a successful POST. */
export interface LinkedWallet {
  /** base58 Solana address */
  address: string;
  /** ISO time of the link */
  linkedAt: string;
}
