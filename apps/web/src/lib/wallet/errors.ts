import type { LinkError } from "./link";

/** HTTP status and player-facing copy of each wallet-link failure (routes send both). */
export const LINK_ERRORS: Record<LinkError, { status: number; message: string }> = {
  bad_address: { status: 400, message: "That isn't a Solana address. Try again." },
  bad_message: { status: 400, message: "The wallet signed an unexpected message. Try again." },
  bad_signature: { status: 400, message: "The signature didn't check out. Try again." },
  address_mismatch: { status: 400, message: "The signature is from a different wallet account. Try again." },
  wrong_nonce: { status: 400, message: "This sign-in request isn't valid any more. Try again." },
  nonce_used: { status: 400, message: "This sign-in request was already used. Try again." },
  expired: { status: 400, message: "The sign-in request expired. Try again." },
  wrong_domain: { status: 400, message: "The wallet signed for a different site. Try again from this page." },
  wrong_uri: { status: 400, message: "The wallet signed for a different site. Try again from this page." },
  wrong_chain: { status: 400, message: "The wallet signed for a different Solana network. Try again." },
  wrong_statement: { status: 400, message: "The wallet signed an unexpected message. Try again." },
  address_taken: { status: 409, message: "This wallet is already linked to another account." },
  already_linked: { status: 409, message: "Unlink your current wallet first." },
  unknown_user: { status: 401, message: "Sign in again." },
};
