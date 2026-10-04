/**
 * Sign-In with Solana message text (EIP-4361 / CAIP-122 shape, as Phantom and
 * @solana/wallet-standard-util write it). Pure and client-safe: the browser builds the text for
 * wallets without `solana:signIn`, the server parses whatever the wallet signed.
 *
 *   ${domain} wants you to sign in with your Solana account:
 *   ${address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: ${version}
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   Expiration Time: ${expirationTime}
 *   Not Before: ${notBefore}
 *   Request ID: ${requestId}
 *   Resources:
 *   - ${resources[0]}
 */
import { BRAND } from "../brand";
import type { SiwsChainId } from "./cluster";

export const SIWS_STATEMENT = `Link this wallet to your ${BRAND.name} account`;
export const SIWS_VERSION = "1";

/** EIP-4361 nonce: at least 8 alphanumeric characters (the server issues 32 hex). */
export const SIWS_NONCE_RE = /^[A-Za-z0-9]{8,64}$/;

export interface SiwsFields {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
}

/** What POST /api/wallet/link/nonce returns: every field except the address, which the wallet adds. */
export interface SiwsChallenge {
  domain: string;
  statement: string;
  uri: string;
  version: string;
  chainId: SiwsChainId;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

export function buildSiwsMessage(f: SiwsFields): string {
  let message = `${f.domain} wants you to sign in with your Solana account:\n${f.address}`;
  if (f.statement) message += `\n\n${f.statement}`;

  const fields: string[] = [];
  if (f.uri) fields.push(`URI: ${f.uri}`);
  if (f.version) fields.push(`Version: ${f.version}`);
  if (f.chainId) fields.push(`Chain ID: ${f.chainId}`);
  if (f.nonce) fields.push(`Nonce: ${f.nonce}`);
  if (f.issuedAt) fields.push(`Issued At: ${f.issuedAt}`);
  if (f.expirationTime) fields.push(`Expiration Time: ${f.expirationTime}`);
  if (f.notBefore) fields.push(`Not Before: ${f.notBefore}`);
  if (f.requestId) fields.push(`Request ID: ${f.requestId}`);
  if (f.resources) {
    fields.push("Resources:");
    for (const r of f.resources) fields.push(`- ${r}`);
  }
  if (fields.length) message += `\n\n${fields.join("\n")}`;
  return message;
}

/** RFC 3986 authority as wallets write it: host or [IPv6] with an optional port. */
const DOMAIN = "(?<domain>[A-Za-z0-9.\\-:\\[\\]]+) wants you to sign in with your Solana account:\\n";
const ADDRESS = "(?<address>[^\\n]+)(?:\\n|$)";
/** EIP-4361: the statement is one line, so it cannot swallow (or fake) the fields below it. */
const STATEMENT = "(?:\\n(?<statement>[^\\n]*)(?:\\n|$))??";
const URI = "(?:\\nURI: (?<uri>[^\\n]+))?";
const VERSION = "(?:\\nVersion: (?<version>[^\\n]+))?";
const CHAIN_ID = "(?:\\nChain ID: (?<chainId>[^\\n]+))?";
const NONCE = "(?:\\nNonce: (?<nonce>[^\\n]+))?";
const ISSUED_AT = "(?:\\nIssued At: (?<issuedAt>[^\\n]+))?";
const EXPIRATION_TIME = "(?:\\nExpiration Time: (?<expirationTime>[^\\n]+))?";
const NOT_BEFORE = "(?:\\nNot Before: (?<notBefore>[^\\n]+))?";
const REQUEST_ID = "(?:\\nRequest ID: (?<requestId>[^\\n]+))?";
const RESOURCES = "(?:\\nResources:(?<resources>(?:\\n- [^\\n]+)*))?";
const MESSAGE_RE = new RegExp(
  `^${DOMAIN}${ADDRESS}${STATEMENT}${URI}${VERSION}${CHAIN_ID}${NONCE}${ISSUED_AT}${EXPIRATION_TIME}${NOT_BEFORE}${REQUEST_ID}${RESOURCES}\\n*$`,
);

/** Parses SIWS text; null when it is not one (a prefixed off-chain message, CRLF lines, junk). */
export function parseSiwsMessage(text: string): SiwsFields | null {
  if (text.length > 4096 || text.includes("\r")) return null;
  const g = MESSAGE_RE.exec(text)?.groups;
  if (!g || !g.domain || !g.address) return null;
  const out: SiwsFields = { domain: g.domain, address: g.address };
  if (g.statement !== undefined) out.statement = g.statement;
  if (g.uri !== undefined) out.uri = g.uri;
  if (g.version !== undefined) out.version = g.version;
  if (g.chainId !== undefined) out.chainId = g.chainId;
  if (g.nonce !== undefined) out.nonce = g.nonce;
  if (g.issuedAt !== undefined) out.issuedAt = g.issuedAt;
  if (g.expirationTime !== undefined) out.expirationTime = g.expirationTime;
  if (g.notBefore !== undefined) out.notBefore = g.notBefore;
  if (g.requestId !== undefined) out.requestId = g.requestId;
  if (g.resources !== undefined) out.resources = g.resources.split("\n- ").slice(1);
  return out;
}

/** "7xKX…AsU2" for UI. */
export function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
