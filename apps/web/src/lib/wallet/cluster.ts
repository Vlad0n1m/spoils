/**
 * Solana cluster of the wallet link (client and server agree because NEXT_PUBLIC_* is inlined into
 * both bundles at build). Default devnet. Only names the chain in the Sign-In with Solana message and
 * the Mobile Wallet Adapter authorization: the link never sends or signs a transaction.
 */

export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";

/** SIWS "Chain ID" values Phantom and the Wallet Standard accept (no "-beta"). */
export type SiwsChainId = "devnet" | "testnet" | "mainnet";

/** Wallet Standard chain identifier. */
export type SolanaChain = `solana:${SiwsChainId}`;

// Literal `process.env.NEXT_PUBLIC_…` so Next.js inlines it into the client bundle.
const RAW_CLUSTER = process.env.NEXT_PUBLIC_SOLANA_CLUSTER;

export function parseCluster(raw: string | undefined): SolanaCluster {
  const v = raw?.trim().toLowerCase();
  if (v === "mainnet" || v === "mainnet-beta") return "mainnet-beta";
  if (v === "testnet") return "testnet";
  return "devnet";
}

export const SOLANA_CLUSTER: SolanaCluster = parseCluster(RAW_CLUSTER);

export function siwsChainId(cluster: SolanaCluster = SOLANA_CLUSTER): SiwsChainId {
  return cluster === "mainnet-beta" ? "mainnet" : cluster;
}

export function walletChain(cluster: SolanaCluster = SOLANA_CLUSTER): SolanaChain {
  return `solana:${siwsChainId(cluster)}`;
}

/** Solana Explorer page of an address on the configured cluster. */
export function explorerAddressUrl(address: string, cluster: SolanaCluster = SOLANA_CLUSTER): string {
  const base = `https://explorer.solana.com/address/${encodeURIComponent(address)}`;
  return cluster === "mainnet-beta" ? base : `${base}?cluster=${cluster}`;
}
