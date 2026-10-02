-- Manual migration: rename balance and match columns from lamports to US dollar cents.
-- For existing databases only. New deployments: use `pnpm db:push` from current Drizzle schema.
--
-- After rename, you may need to transform old data, e.g.:
--   UPDATE users SET balance_cents = 0;  -- or a mapping from old lamport balances
--   (There is no single correct lamports → USD cents conversion without an FX rate.)

ALTER TABLE "users" RENAME COLUMN "balance_lamports" TO "balance_cents";
ALTER TABLE "deposits" RENAME COLUMN "lamports" TO "amount_cents";
ALTER TABLE "withdrawals" RENAME COLUMN "lamports" TO "amount_cents";
ALTER TABLE "matches" RENAME COLUMN "entry_tier_lamports" TO "entry_tier_cents";
ALTER TABLE "match_participants" RENAME COLUMN "entry_lamports" TO "entry_cents";
ALTER TABLE "match_participants" RENAME COLUMN "payout_lamports" TO "payout_cents";
ALTER TABLE "match_participants" RENAME COLUMN "delta_lamports" TO "delta_cents";
