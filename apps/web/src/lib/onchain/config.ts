import { PublicKey } from "@solana/web3.js";
import { STARTER_KIT } from "@extract/shared";
import { chainCluster, chainRpcUrl, loadChainAuthority } from "../chain/config";

export { formatSol, parseSol } from "./sol";

/**
 * On-chain items and the SOL market (README "On-chain"). The server authority of the event
 * recorder (CHAIN_AUTHORITY_SECRET) also runs this part: it is the update authority of the SPOILS
 * Core collection, the payer of mints, the game vault that holds items brought back into the game
 * and, unless ONCHAIN_TREASURY says otherwise, the treasury that receives market fees and kit
 * payments (so the fees pay for the next mints).
 *
 *   ONCHAIN_COLLECTION        SPOILS Core collection address (programs/scripts/onchain-admin.ts
 *                             create-collection). Unset = the whole feature is off.
 *   ONCHAIN_MARKET_PROGRAM_ID spoils_market program id (default: the devnet deployment).
 *   ONCHAIN_TREASURY          receiver of market fees and kit payments (default: the authority).
 *   ONCHAIN_MIN_RARITY        lowest rarity that can leave the game (default 2 = epic).
 *   ONCHAIN_KIT_LAMPORTS      starter kit price paid from the wallet (default STARTER_KIT price).
 */

type EnvSource = Record<string, string | undefined>;
const val = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** spoils_market on devnet (programs/Anchor.toml). */
export const DEVNET_MARKET_PROGRAM_ID = "3eu7K4GkLw1CA74Z4JSadBjsxZHNpaauWTtky6u52eGB";
export const CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** STARTER_KIT.PRICE_MINOR is in hundredths of a SOL (balance_cents): 5 → 0.05 SOL. */
const MINOR_LAMPORTS = 10_000_000n;

export interface OnchainConfig {
  rpcUrl: string;
  cluster: string;
  collection: PublicKey;
  marketProgram: PublicKey;
  /** The game vault: items in the game whose asset exists sit here. Equals the authority. */
  vault: PublicKey;
  treasury: PublicKey;
  minRarity: number;
  kitLamports: bigint;
}

function pubkey(v: string | undefined): PublicKey | null {
  if (!v) return null;
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
}

/** Null when the feature is off (no collection or no authority key). */
export function onchainConfig(env: EnvSource = process.env): OnchainConfig | null {
  const collection = pubkey(val(env.ONCHAIN_COLLECTION));
  const auth = loadChainAuthority(env);
  if (!collection || !auth) return null;
  const vault = auth.keypair.publicKey;
  const minRarity = Number(val(env.ONCHAIN_MIN_RARITY) ?? 2);
  const kit = val(env.ONCHAIN_KIT_LAMPORTS);
  return {
    rpcUrl: chainRpcUrl(env),
    cluster: chainCluster(env),
    collection,
    marketProgram: pubkey(val(env.ONCHAIN_MARKET_PROGRAM_ID)) ?? new PublicKey(DEVNET_MARKET_PROGRAM_ID),
    vault,
    treasury: pubkey(val(env.ONCHAIN_TREASURY)) ?? vault,
    minRarity: Number.isInteger(minRarity) ? Math.max(0, Math.min(3, minRarity)) : 2,
    kitLamports: kit && /^\d{1,15}$/.test(kit) ? BigInt(kit) : BigInt(STARTER_KIT.PRICE_MINOR) * MINOR_LAMPORTS,
  };
}
