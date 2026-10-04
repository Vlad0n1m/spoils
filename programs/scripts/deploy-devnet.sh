#!/usr/bin/env bash
# One-shot devnet setup of the spoils_events program (README "On-chain"), safe to re-run:
#   1. deploy (skipped when the program already exists) with programs/.keys/deploy.json as payer and
#      upgrade authority and programs/.keys/program.json as the program id;
#   2. initialize the Config with programs/.keys/authority.json as the record signer;
#   3. move 0.2 devnet SOL to the record signer for its transaction fees;
#   4. send one test event of each kind through the web worker (test database extract_test);
#   5. print the program, Config counters and balances.
# Needs about 3 devnet SOL on the deploy key (deploy buffer + program data rent; the buffer part comes
# back). Every command gets an explicit URL and keypair: the global Solana CLI config is never used.
#
#   programs/scripts/deploy-devnet.sh            (from anywhere; SOLANA_DEVNET_URL overrides the RPC)
set -euo pipefail
cd "$(dirname "$0")/.."
URL=${SOLANA_DEVNET_URL:-https://api.devnet.solana.com}
DEPLOY=.keys/deploy.json
PROGRAM_ID=$(solana-keygen pubkey .keys/program.json)
TSX=../apps/game-server/node_modules/.bin/tsx
ADMIN="$TSX scripts/chain-admin.ts"

if solana program show "$PROGRAM_ID" --url "$URL" >/dev/null 2>&1; then
  echo "program $PROGRAM_ID already deployed"
else
  PAYER=$(solana-keygen pubkey "$DEPLOY")
  BAL=$(solana balance "$PAYER" --url "$URL" | awk '{print $1}')
  echo "deploy key $PAYER: $BAL SOL"
  if awk "BEGIN { exit !($BAL < 2.9) }"; then
    echo "not enough devnet SOL: fund $PAYER with ~3 SOL (https://faucet.solana.com) and re-run" >&2
    exit 1
  fi
  [ -f target/deploy/spoils_events.so ] || nice -n 10 env CARGO_BUILD_JOBS=4 anchor build
  mkdir -p target/deploy
  cmp -s .keys/program.json target/deploy/spoils_events-keypair.json || install -m 600 .keys/program.json target/deploy/spoils_events-keypair.json
  anchor deploy --provider.cluster "$URL" --provider.wallet "$DEPLOY"
fi

$ADMIN init --url "$URL"
AUTH=$(solana-keygen pubkey .keys/authority.json)
AUTH_BAL=$(solana balance "$AUTH" --url "$URL" | awk '{print $1}')
if awk "BEGIN { exit !($AUTH_BAL < 0.05) }"; then $ADMIN fund-authority 0.2 --url "$URL"; fi
$ADMIN send-test-events --url "$URL"
$ADMIN status --url "$URL"
echo "explorer: https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
