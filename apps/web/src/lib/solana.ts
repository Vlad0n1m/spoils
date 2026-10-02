import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { coreEnv } from "./env";

let connection: Connection | undefined;
export function getConnection() {
  if (connection) return connection;
  connection = new Connection(coreEnv().SOLANA_RPC_URL, "confirmed");
  return connection;
}

let hotWallet: Keypair | undefined;
export function getHotWallet(): Keypair {
  const b58 = process.env.HOT_WALLET_SECRET_B58?.trim();
  if (!b58) {
    throw new Error(
      "HOT_WALLET_SECRET_B58 not set — configure for withdrawals / deposit sweep",
    );
  }
  if (hotWallet) return hotWallet;
  const sk = bs58.decode(b58);
  hotWallet = Keypair.fromSecretKey(sk);
  return hotWallet;
}

export function isHotWalletConfigured(): boolean {
  return Boolean(process.env.HOT_WALLET_SECRET_B58?.trim());
}
