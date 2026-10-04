import { db } from "@/db/client";
import { chainCluster, chainProgramId, explorerUrl } from "@/lib/chain/config";
import { getChainSummary, type ChainSummary } from "@/lib/chain/queue";
import { cleanError } from "@/lib/chain/worker";
import type { ChainEventKind } from "@/lib/chain/events";

const KINDS: Array<{ kind: ChainEventKind; label: string; what: string }> = [
  {
    kind: "match",
    label: "Map results",
    what: "Every settled 45-minute map: cycle, map copy, how many raiders and how many went missing, and a fingerprint (hash) of the full end report.",
  },
  {
    kind: "boss_kill",
    label: "Boss kills",
    what: "Which boss fell in which cycle, and a hashed id of the raider who killed it.",
  },
  {
    kind: "rare_extract",
    label: "Rare extracts",
    what: "Epic and legendary finds brought out of a map: item type, rarity, cycle and a hashed id of the owner.",
  },
];

/**
 * The /economy "On-chain" block: the spoils_events program, what it records and the latest
 * transactions from chain_events. Renders its static part even when the database read fails.
 */
export async function OnChainBlock() {
  let summary: ChainSummary | null = null;
  try {
    summary = await getChainSummary(db);
  } catch (e) {
    console.error("[economy] on-chain summary failed", cleanError(e));
  }
  let programId: string | null = null;
  try {
    programId = chainProgramId().toBase58();
  } catch {
    programId = null;
  }
  const cluster = chainCluster();
  const clusterName = cluster === "mainnet-beta" ? "Solana mainnet" : `Solana ${cluster}`;

  return (
    <section className="toon-panel mt-6 bg-[#161b28]/95 p-5" aria-labelledby="on-chain-title">
      <h2 id="on-chain-title" className="toon-text-thin text-2xl tracking-wide text-white">
        On-chain
      </h2>
      <p className="font-body mt-3 max-w-[70ch] text-sm leading-relaxed text-white/70">
        Game results are written to a public program on {clusterName}, so anyone can check them. The game server signs and
        pays for every record; players never sign anything and never pay a fee for it. No account ids, nicknames or emails
        go on chain: raiders appear only as salted hashes.
      </p>

      {programId && (
        <div className="font-body mt-4 rounded-lg border border-white/10 bg-black/20 p-3 text-sm">
          <p className="text-xs uppercase tracking-wider text-white/45">Program</p>
          <p className="mt-1 break-all font-mono text-[0.8rem] text-white/85">{programId}</p>
          <a
            href={explorerUrl("address", programId, cluster)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-zooa-lime underline-offset-4 hover:underline"
          >
            View on Solana Explorer ↗
          </a>
        </div>
      )}

      <table className="font-body mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-white/45">
            <th className="py-2 font-normal">Recorded</th>
            <th className="py-2 text-right font-normal">On chain</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {KINDS.map((k) => {
            const c = summary?.counts[k.kind];
            return (
              <tr key={k.kind}>
                <td className="py-2.5 pr-4 align-top">
                  <span className="text-white">{k.label}</span>
                  <span className="block text-xs leading-relaxed text-white/45">{k.what}</span>
                </td>
                <td className="py-2.5 text-right align-top tabular-nums">
                  <span className="text-lg text-white">{c ? c.sent : "—"}</span>
                  {c && c.queued > 0 && <span className="block text-xs text-white/45">{c.queued} queued</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="font-body mt-4">
        <p className="text-xs uppercase tracking-wider text-white/45">Latest transactions</p>
        {summary && summary.recent.length > 0 ? (
          <ul className="mt-2 space-y-1.5 text-sm">
            {summary.recent.map((r) => (
              <li key={r.txSig} className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-white/70">{KINDS.find((k) => k.kind === r.kind)?.label ?? r.kind}</span>
                <a
                  href={explorerUrl("tx", r.txSig, cluster)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[0.8rem] text-zooa-lime underline-offset-4 hover:underline"
                >
                  {r.txSig.slice(0, 8)}…{r.txSig.slice(-8)} ↗
                </a>
                <span className="text-xs text-white/40">{r.sentAt.toUTCString()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-white/50">No transactions yet.</p>
        )}
      </div>
    </section>
  );
}
