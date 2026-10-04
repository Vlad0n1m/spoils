/**
 * Devnet operator script for the spoils_events program (README "On-chain"). Keys come from the
 * gitignored programs/.keys/ folder; only public keys and signatures are printed.
 *
 *   T=apps/game-server/node_modules/.bin/tsx
 *   $T programs/scripts/chain-admin.ts status             program, Config PDA, counters, balances
 *   $T programs/scripts/chain-admin.ts init               initialize(authority.json) as the upgrade authority
 *   $T programs/scripts/chain-admin.ts fund-authority 0.2 devnet SOL deploy.json → authority.json (fees)
 *   $T programs/scripts/chain-admin.ts send-test-events   queue one event of each kind in the TEST
 *                                                         database (extract_test) and send them with
 *                                                         the real worker
 * Options: --url <rpc> (default https://api.devnet.solana.com).
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { balanceSol, chainStatus, initializeConfig, topUp } from "../../apps/web/src/lib/chain/admin";
import { chainHashSalt, explorerUrl, parseSecretKey } from "../../apps/web/src/lib/chain/config";
import { bossKillEvent, matchEvent, rareExtractEvent } from "../../apps/web/src/lib/chain/events";
import { configPda } from "../../apps/web/src/lib/chain/program";
import { enqueueChainEvents } from "../../apps/web/src/lib/chain/queue";
import { chainConnection, createWeb3Sender } from "../../apps/web/src/lib/chain/sender";
import { runChainWorker } from "../../apps/web/src/lib/chain/worker";
import { closeTestDb, openTestDb } from "../../apps/web/src/lib/inventory/test-db";

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const RPC = urlFlag >= 0 ? args[urlFlag + 1]! : "https://api.devnet.solana.com";
const [cmd, arg] = args.filter((_, i) => urlFlag < 0 || (i !== urlFlag && i !== urlFlag + 1));

function key(name: "deploy" | "authority" | "program") {
  const kp = parseSecretKey(readFileSync(new URL(`../.keys/${name}.json`, import.meta.url), "utf8"));
  if (!kp) throw new Error(`programs/.keys/${name}.json is not a keypair file`);
  return kp;
}

const conn = chainConnection(RPC, 20_000);
const programId = key("program").publicKey;
const tx = (sig: string) => `${sig}\n    ${explorerUrl("tx", sig)}`;

async function status() {
  const s = await chainStatus(conn, programId);
  const deploy = key("deploy").publicKey;
  const authority = key("authority").publicKey;
  console.log(`program    ${s.programId} deployed=${s.programDeployed}\n    ${explorerUrl("address", s.programId)}`);
  console.log(`config     ${s.config}`);
  if (s.state) {
    console.log(`  authority ${s.state.authority.toBase58()}${s.state.authority.equals(authority) ? " (authority.json)" : ""}`);
    console.log(`  counters  matches=${s.state.matches} boss_kills=${s.state.bossKills} rare_extracts=${s.state.rareExtracts}`);
  } else console.log("  not initialized");
  console.log(`deploy     ${deploy.toBase58()} ${await balanceSol(conn, deploy)} SOL`);
  console.log(`authority  ${authority.toBase58()} ${await balanceSol(conn, authority)} SOL`);
}

async function init() {
  const s = await chainStatus(conn, programId);
  if (!s.programDeployed) throw new Error("program is not deployed on this cluster");
  if (s.state) {
    console.log(`already initialized: config ${configPda(programId).toBase58()} authority ${s.state.authority.toBase58()}`);
    return;
  }
  console.log(`initialize: ${tx(await initializeConfig(conn, key("deploy"), programId, key("authority").publicKey))}`);
}

async function fund() {
  const sol = Number(arg ?? "0.2");
  if (!(sol > 0 && sol <= 2)) throw new Error("amount must be in (0, 2] SOL");
  if (!/devnet|localhost|127\.0\.0\.1/.test(RPC)) throw new Error("fund-authority is for devnet only");
  console.log(`transfer ${sol} SOL: ${tx(await topUp(conn, key("deploy"), key("authority").publicKey, sol))}`);
}

async function sendTestEvents() {
  const { db, pool } = openTestDb();
  try {
    const cycleId = Math.floor(Date.now() / (45 * 60_000));
    const matchId = randomUUID();
    const owner = randomUUID();
    const now = new Date();
    const n = await enqueueChainEvents(
      db,
      [
        matchEvent(
          {
            matchId,
            mapId: "steppe",
            matchSeed: 1,
            startedAt: cycleId * 45 * 60_000,
            endedAt: (cycleId + 1) * 45 * 60_000,
            participants: [
              { userId: owner, nickname: "devnet-a", isBot: false, exitType: "extract", kills: 2 },
              { userId: randomUUID(), nickname: "devnet-b", isBot: false, exitType: "dead", kills: 0 },
              { userId: randomUUID(), nickname: "devnet-c", isBot: false, exitType: "mia", kills: 0 },
            ],
            leftOnMap: [],
            minted: [],
            cycleId,
            shard: 0,
            entries: [],
          },
          "live",
        ),
        bossKillEvent({ matchId, cycleId, kind: "boss_killed", boss: "warden", by: "devnet-a", atMs: 1_200_000 }, owner),
        rareExtractEvent({ entryId: randomUUID(), matchId, cycleId, ownerId: owner }, { itemId: randomUUID(), def: "rifle", rarity: 3, qty: 1 }),
      ],
      now,
    );
    console.log(`queued ${n} test events in extract_test (cycle ${cycleId})`);
    const salt = chainHashSalt({ NODE_ENV: "development" })!;
    const sender = createWeb3Sender({ rpcUrl: RPC, authority: key("authority"), programId, confirmTimeoutMs: 30_000 });
    const r = await runChainWorker(db, sender, { salt, limit: 10, budgetMs: 120_000 });
    console.log(`worker: claimed=${r.claimed} sent=${r.sent} retried=${r.retried} failed=${r.failed}`);
    for (const s of r.signatures) console.log(`  ${tx(s)}`);
  } finally {
    await closeTestDb(pool);
  }
}

const run: Record<string, () => Promise<void>> = { status, init, "fund-authority": fund, "send-test-events": sendTestEvents };
const f = cmd ? run[cmd] : undefined;
if (!f) {
  console.error(`usage: chain-admin.ts ${Object.keys(run).join(" | ")} [--url <rpc>]`);
  process.exit(2);
}
f().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`[chain-admin] ${cmd} failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
