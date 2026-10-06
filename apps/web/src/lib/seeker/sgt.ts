/**
 * Seeker Genesis Token (SGT) ownership on Solana MAINNET, read-only.
 *
 * Source: https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token (checked 2026-10-06).
 * The SGT is a Token-2022 (Token Extensions) NFT minted once per Seeker phone into the Seed Vault
 * Wallet's primary account; it moves only when the user changes that primary account, and its mint
 * address stays the same. The docs' check, done here with standard RPC methods (no Helius extension
 * needed):
 *  1. the wallet's Token-2022 token accounts (getTokenAccountsByOwner, programId Token-2022,
 *     jsonParsed), skipping zero-balance accounts — moving an SGT out leaves the old account open at 0;
 *  2. each held mint (getMultipleAccounts, jsonParsed, batches of 100) is an SGT when it is a
 *     Token-2022 mint whose MetadataPointer points at SGT.METADATA and whose TokenGroupMember belongs
 *     to SGT.GROUP (the same address by design). Both must match.
 *  3. return the SGT's mint address, not a boolean: a one-time reward is claimed once per mint
 *     (the docs' anti-sybil rule, seeker.ts).
 * The mint authority (SGT.MINT_AUTHORITY) is checked too when the RPC returns it: every SGT on chain
 * has it, and it costs nothing.
 *
 * The parsers are pure and take raw JSON-RPC bodies, so sgt.test.ts runs them on recorded mainnet
 * responses.
 */

export const SGT = {
  /** Token-2022 (Token Extensions) program. */
  TOKEN_2022_PROGRAM: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  /** MetadataPointer.metadataAddress of every SGT. */
  METADATA: "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te",
  /** TokenGroupMember.group of every SGT ("intentionally the same" as the metadata address, per the docs). */
  GROUP: "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te",
  /** Mint authority of the SGT mints. */
  MINT_AUTHORITY: "GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4",
  /** getMultipleAccounts takes at most 100 keys. */
  BATCH: 100,
} as const;

/** Public mainnet endpoint; set SEEKER_RPC_URL (e.g. a Helius URL) for production rate limits. */
export const DEFAULT_SEEKER_RPC_URL = "https://api.mainnet-beta.solana.com";

export function seekerRpcUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const v = env.SEEKER_RPC_URL?.trim();
  return v ? v : DEFAULT_SEEKER_RPC_URL;
}

export class SgtRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SgtRpcError";
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** `result` of a JSON-RPC body; throws on an error object or a malformed body. */
function rpcResult(body: unknown): Obj {
  const b = obj(body);
  if (!b) throw new SgtRpcError("malformed RPC body");
  const err = obj(b.error);
  if (err) throw new SgtRpcError(`RPC error ${String(err.code ?? "")}: ${String(err.message ?? "")}`.trim());
  const r = obj(b.result);
  if (!r) throw new SgtRpcError("RPC body without result");
  return r;
}

/**
 * Mints of the non-empty Token-2022 accounts in a getTokenAccountsByOwner (jsonParsed) body, in
 * order, without duplicates. Accounts of `owner` only, when given (the RPC filters by owner already;
 * this guards against a wrong endpoint). Throws SgtRpcError on an RPC error.
 */
export function heldMints(body: unknown, owner?: string): string[] {
  const value = rpcResult(body).value;
  if (!Array.isArray(value)) throw new SgtRpcError("getTokenAccountsByOwner: no value array");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const account = obj(obj(entry)?.account);
    if (account && str(account.owner) && account.owner !== SGT.TOKEN_2022_PROGRAM) continue;
    const parsed = obj(obj(account?.data)?.parsed);
    if (!parsed || (parsed.type !== undefined && parsed.type !== "account")) continue;
    const info = obj(parsed.info);
    const mint = str(info?.mint);
    if (!info || !mint) continue;
    if (owner && str(info.owner) && info.owner !== owner) continue;
    const amount = str(obj(info.tokenAmount)?.amount);
    if (!amount || !/^\d+$/.test(amount) || /^0+$/.test(amount)) continue;
    if (seen.has(mint)) continue;
    seen.add(mint);
    out.push(mint);
  }
  return out;
}

/** True when one parsed Token-2022 mint account is a Seeker Genesis Token. */
export function isSgtMintAccount(account: unknown): boolean {
  const a = obj(account);
  if (!a || a.owner !== SGT.TOKEN_2022_PROGRAM) return false;
  const parsed = obj(obj(a.data)?.parsed);
  if (!parsed || parsed.type !== "mint") return false;
  const info = obj(parsed.info);
  if (!info) return false;
  // Every SGT has this mint authority; an absent field (older RPC shapes) does not fail the check.
  if (info.mintAuthority !== undefined && info.mintAuthority !== SGT.MINT_AUTHORITY) return false;
  const exts = Array.isArray(info.extensions) ? info.extensions.map(obj) : [];
  const ext = (name: string) => obj(exts.find((e) => e?.extension === name)?.state);
  const metadataOk = ext("metadataPointer")?.metadataAddress === SGT.METADATA;
  const groupOk = ext("tokenGroupMember")?.group === SGT.GROUP;
  return metadataOk && groupOk;
}

/**
 * The first SGT among `mints` in a getMultipleAccounts (jsonParsed) body, or null. The value array is
 * in the order of the requested keys; missing accounts are null. Throws SgtRpcError on an RPC error.
 */
export function sgtMintIn(body: unknown, mints: readonly string[]): string | null {
  const value = rpcResult(body).value;
  if (!Array.isArray(value)) throw new SgtRpcError("getMultipleAccounts: no value array");
  for (let i = 0; i < value.length && i < mints.length; i++) {
    if (isSgtMintAccount(value[i])) return mints[i]!;
  }
  return null;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface SgtCheckOpts {
  rpcUrl?: string;
  fetch?: FetchLike;
  /** Per request; the whole check makes 2+ requests. */
  timeoutMs?: number;
}

async function rpc(method: string, params: unknown[], o: Required<Pick<SgtCheckOpts, "rpcUrl" | "fetch" | "timeoutMs">>): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  try {
    const res = await o.fetch(o.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new SgtRpcError(`${method}: HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e instanceof SgtRpcError) throw e;
    throw new SgtRpcError(`${method}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SGT mint `wallet` holds right now on mainnet, or null when it holds none. Throws SgtRpcError
 * when the RPC fails (the caller must not cache that as "no SGT").
 */
export async function findSgtMint(wallet: string, opts: SgtCheckOpts = {}): Promise<string | null> {
  const o = {
    rpcUrl: opts.rpcUrl ?? seekerRpcUrl(),
    fetch: opts.fetch ?? (globalThis.fetch as unknown as FetchLike),
    timeoutMs: opts.timeoutMs ?? 8_000,
  };
  const accounts = await rpc("getTokenAccountsByOwner", [wallet, { programId: SGT.TOKEN_2022_PROGRAM }, { encoding: "jsonParsed", commitment: "confirmed" }], o);
  const mints = heldMints(accounts, wallet);
  for (let i = 0; i < mints.length; i += SGT.BATCH) {
    const batch = mints.slice(i, i + SGT.BATCH);
    const body = await rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed", commitment: "confirmed" }], o);
    const hit = sgtMintIn(body, batch);
    if (hit) return hit;
  }
  return null;
}
