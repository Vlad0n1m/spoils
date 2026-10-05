"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { Wallet } from "@wallet-standard/base";
import { describeItem } from "@/lib/items-ui";
import { formatSol, parseSol } from "@/lib/onchain/sol";
import type { ChainItemDto, ChainListingDto, ChainOpDto } from "@/lib/onchain/reads";
import { ItemCard } from "@/components/lobby/item-card";
import { api, useResource } from "@/components/lobby/use-lobby";
import { signPrepared, signingWallets } from "./sign";

interface EligibleDto {
  itemId: string;
  def: string;
  rarity: number;
  dur: number;
  maxDur: number;
  minted: boolean;
}

interface StateDto {
  enabled: boolean;
  signedIn?: boolean;
  cluster?: string;
  collectionExplorer?: string;
  marketExplorer?: string;
  minRarity?: number;
  kit?: { lamports: string; dailyMax: number };
  market?: { feeBps: number; listed: string; sold: string; volumeLamports: string } | null;
  wallet?: string | null;
  walletLamports?: string | null;
  walletExplorer?: string | null;
  eligible?: EligibleDto[];
  inWallet?: ChainItemDto[];
  ops?: ChainOpDto[];
  kitBoughtToday?: number;
}

type OpResult = { status: "done" | "sent" | "failed" | "expired"; signature: string; error?: string };

const ACTION_LABEL: Record<string, string> = {
  export: "Sent to wallet",
  import: "Brought into the game",
  kit: "Starter kit",
  list: "Listed for SOL",
  buy: "Bought for SOL",
  cancel: "Listing cancelled",
};

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * /onchain: SPOILS on Solana. Epic+ items leave the game as Metaplex Core assets in the player's
 * wallet, trade for SOL on the spoils_market escrow program, and come back into the game; the
 * starter kit is paid straight from the wallet. The server prepares every transaction, the wallet
 * signs it here (sign.ts), the server relays it and applies the game effect once it is confirmed.
 */
export function OnchainPanel() {
  const st = useResource<StateDto>("/api/onchain/state");
  const mk = useResource<{ enabled: boolean; listings: ChainListingDto[] }>("/api/onchain/market");
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});

  useEffect(() => {
    const refresh = () => {
      const ws = signingWallets();
      setWallets(ws);
      setWalletName((cur) => cur ?? ws[0]?.name ?? null);
    };
    refresh();
    const t = window.setInterval(refresh, 1500);
    return () => window.clearInterval(t);
  }, []);

  const s = st.data;
  const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}${s?.cluster && s.cluster !== "mainnet-beta" ? `?cluster=${s.cluster}` : ""}`;
  const reload = () => {
    void st.reload();
    void mk.reload();
  };

  const report = (r: OpResult, okText: string) => {
    if (r.status === "done") setMsg({ ok: true, text: okText, link: explorerTx(r.signature) });
    else if (r.status === "sent") setMsg({ ok: true, text: "Sent to Solana, still confirming. It will show up here shortly.", link: explorerTx(r.signature) });
    else setMsg({ ok: false, text: `Solana refused the transaction${r.error ? ` (${r.error})` : ""}. Nothing changed in the game.`, link: explorerTx(r.signature) });
  };

  /** prepare → wallet signs → submit. */
  const walletOp = async (key: string, body: Record<string, string>, okText: string) => {
    const w = wallets.find((x) => x.name === walletName);
    if (!s?.wallet) return setMsg({ ok: false, text: "Link a Solana wallet first." });
    if (!w) return setMsg({ ok: false, text: "No wallet that can sign transactions found on this device." });
    setBusy(key);
    setMsg(null);
    try {
      const p = await api<{ opId: string; tx: string }>("/api/onchain/prepare", { body });
      const signed = await signPrepared(w, s.wallet, p.tx);
      setMsg({ ok: true, text: "Sending to Solana…" });
      report(await api<OpResult>("/api/onchain/submit", { body: { opId: p.opId, tx: signed } }), okText);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Something went wrong." });
    } finally {
      setBusy(null);
      reload();
    }
  };

  const exportItem = async (it: EligibleDto) => {
    setBusy(it.itemId);
    setMsg({ ok: true, text: it.minted ? "Sending it to your wallet…" : "Minting it into your wallet…" });
    try {
      report(await api<OpResult>("/api/onchain/export", { body: { itemId: it.itemId } }), `${name(it)} is in your wallet now.`);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Something went wrong." });
    } finally {
      setBusy(null);
      reload();
    }
  };

  if (st.loading && !s) return <Shell><p className="font-body text-white/70">Loading…</p></Shell>;
  if (!s?.enabled) {
    return (
      <Shell>
        <p className="font-body text-white/75">On-chain items are not enabled on this server yet.</p>
      </Shell>
    );
  }

  const listings = mk.data?.listings ?? [];
  const kitLeft = (s.kit?.dailyMax ?? 0) - (s.kitBoughtToday ?? 0);

  return (
    <Shell>
      <section className="toon-panel bg-[#161b28]/95 p-5">
        <p className="font-body max-w-[70ch] text-sm leading-relaxed text-white/75">
          Epic and legendary gear you extract can leave the game as a real Solana asset in your own wallet (Metaplex Core, collection{" "}
          <a className="text-sky-300 underline" href={s.collectionExplorer} target="_blank" rel="noreferrer">SPOILS Items</a>). Trade it for SOL on
          the{" "}
          <a className="text-sky-300 underline" href={s.marketExplorer} target="_blank" rel="noreferrer">SPOILS market program</a>: the item waits in
          escrow, the buyer pays the seller in the same transaction, and the game never holds your SOL. Bring it back into the game any time.
          Network: <b>{s.cluster}</b>.
        </p>
        {s.market && (
          <p className="font-body mt-3 text-xs text-white/60">
            On chain so far: {s.market.listed} listed · {s.market.sold} sold · {formatSol(s.market.volumeLamports)} traded · {s.market.feeBps / 100}% fee
          </p>
        )}
      </section>

      {msg && (
        <p role="status" className={clsx("font-body rounded-xl border-2 border-black px-3 py-2 text-sm font-semibold text-black", msg.ok ? "bg-zooa-lime" : "bg-rose-300")}>
          {msg.text}{" "}
          {msg.link && (
            <a href={msg.link} target="_blank" rel="noreferrer" className="underline">
              View on Solana Explorer
            </a>
          )}
        </p>
      )}

      {!s.signedIn ? (
        <Panel title="Wallet">
          <p className="font-body text-sm text-white/75">Sign in to use your items on Solana. You can still browse the SOL market below.</p>
        </Panel>
      ) : !s.wallet ? (
        <Panel title="Wallet">
          <p className="font-body text-sm text-white/75">Link a Solana wallet to your account first (one signature, no transaction).</p>
          <Link href="/wallet" className="toon-btn mt-3 inline-flex min-h-10 px-4 text-sm">
            <span className="optical-center">Link wallet</span>
          </Link>
        </Panel>
      ) : (
        <Panel title="Wallet">
          <p className="font-body text-sm text-white/80">
            Linked:{" "}
            <a href={s.walletExplorer ?? "#"} target="_blank" rel="noreferrer" className="tabular-nums text-sky-300 underline">
              {short(s.wallet)}
            </a>
            {s.walletLamports !== null && s.walletLamports !== undefined && <> · {formatSol(s.walletLamports)}</>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-body text-white/70">Sign with:</span>
            {wallets.length === 0 ? (
              <span className="font-body text-white/60">no wallet found on this device (install Phantom or Solflare)</span>
            ) : (
              wallets.map((w) => (
                <button
                  key={w.name}
                  type="button"
                  onClick={() => setWalletName(w.name)}
                  className={clsx("rounded-full border-2 border-black px-3 py-1 text-xs", walletName === w.name ? "bg-zooa-lime text-black" : "bg-white/10 text-white")}
                >
                  {w.name}
                </button>
              ))
            )}
          </div>
          {s.cluster === "devnet" && (
            <p className="font-body mt-2 text-xs text-white/60">
              Devnet: set your wallet to Devnet and get free test SOL at{" "}
              <a className="underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a>.
            </p>
          )}
        </Panel>
      )}

      {s.signedIn && s.wallet && s.kit && (
        <Panel title="Starter kit">
          <p className="font-body text-sm text-white/75">
            Three pistols, armor, ammo and meds, paid straight from your wallet to the game treasury: {formatSol(s.kit.lamports)}. {kitLeft > 0 ? `${kitLeft} left today.` : "Daily limit reached."}
          </p>
          <button
            type="button"
            disabled={busy !== null || kitLeft <= 0}
            onClick={() => walletOp("kit", { action: "kit" }, "Starter kit paid on Solana and added to your stash.")}
            className="toon-btn mt-3 min-h-10 px-4 text-sm disabled:opacity-50"
          >
            <span className="optical-center">{busy === "kit" ? "Waiting for the wallet…" : `Buy for ${formatSol(s.kit.lamports)}`}</span>
          </button>
        </Panel>
      )}

      {s.signedIn && s.wallet && (
        <Panel title="Send to wallet">
          {(s.eligible ?? []).length === 0 ? (
            <p className="font-body text-sm text-white/70">
              No eligible items in your stash. Extract with epic or legendary gear (tradable, not in a loadout) and it shows up here.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {s.eligible!.map((it) => (
                <Row key={it.itemId} def={it.def} rarity={it.rarity} dur={it.dur} sub={it.minted ? "back out of the game vault" : "minted on first send"}>
                  <button type="button" disabled={busy !== null} onClick={() => exportItem(it)} className="toon-btn min-h-9 px-3 text-sm disabled:opacity-50">
                    <span className="optical-center">{busy === it.itemId ? "…" : "Send"}</span>
                  </button>
                </Row>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {s.signedIn && s.wallet && (
        <Panel title="In your wallet">
          {(s.inWallet ?? []).length === 0 ? (
            <p className="font-body text-sm text-white/70">No SPOILS items in your linked wallet.</p>
          ) : (
            <ul className="grid gap-2">
              {s.inWallet!.map((it) => {
                const price = prices[it.asset] ?? "";
                const lamports = parseSol(price);
                return (
                  <Row key={it.asset} def={it.def} rarity={it.rarity} dur={it.dur} sub={<a href={it.explorer} target="_blank" rel="noreferrer" className="underline">{short(it.asset)}</a>}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => walletOp(`imp:${it.asset}`, { action: "import", asset: it.asset }, `${name(it)} is back in your stash.`)}
                        className="toon-btn-ghost min-h-9 px-3 text-sm disabled:opacity-50"
                      >
                        <span className="optical-center">{busy === `imp:${it.asset}` ? "…" : "Into game"}</span>
                      </button>
                      <input
                        inputMode="decimal"
                        placeholder="SOL"
                        value={price}
                        onChange={(e) => setPrices((p) => ({ ...p, [it.asset]: e.target.value }))}
                        className="w-20 rounded-xl border-2 border-black bg-white px-2 py-1.5 text-sm tabular-nums text-black"
                        aria-label="Price in SOL"
                      />
                      <button
                        type="button"
                        disabled={busy !== null || !lamports}
                        onClick={() => walletOp(`list:${it.asset}`, { action: "list", asset: it.asset, price }, `Listed for ${price} SOL.`)}
                        className="toon-btn min-h-9 px-3 text-sm disabled:opacity-50"
                      >
                        <span className="optical-center">{busy === `list:${it.asset}` ? "…" : "Sell"}</span>
                      </button>
                    </div>
                  </Row>
                );
              })}
            </ul>
          )}
        </Panel>
      )}

      <Panel title="SOL market">
        {mk.error && <p className="font-body text-sm text-rose-300">{mk.error}</p>}
        {listings.length === 0 ? (
          <p className="font-body text-sm text-white/70">{mk.loading ? "Loading…" : "Nothing listed for SOL yet."}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {listings.map((l) => (
              <Row key={l.asset} def={l.def} rarity={l.rarity} dur={l.dur} sub={<>{l.mine ? "your lot" : `seller ${short(l.seller)}`} · <a href={l.explorer} target="_blank" rel="noreferrer" className="underline">asset</a></>}>
                <div className="flex items-center gap-2">
                  <span className="toon-text-thin text-lg tabular-nums text-zooa-lime">{formatSol(l.priceLamports)}</span>
                  {l.mine ? (
                    <button type="button" disabled={busy !== null} onClick={() => walletOp(`cancel:${l.asset}`, { action: "cancel", asset: l.asset }, "Listing cancelled; the item is back in your wallet.")} className="toon-btn-ghost min-h-9 px-3 text-sm disabled:opacity-50">
                      <span className="optical-center">{busy === `cancel:${l.asset}` ? "…" : "Cancel"}</span>
                    </button>
                  ) : s.wallet ? (
                    <button type="button" disabled={busy !== null} onClick={() => walletOp(`buy:${l.asset}`, { action: "buy", asset: l.asset }, `Bought ${name(l)}. It's in your wallet.`)} className="toon-btn min-h-9 px-3 text-sm disabled:opacity-50">
                      <span className="optical-center">{busy === `buy:${l.asset}` ? "…" : "Buy"}</span>
                    </button>
                  ) : null}
                </div>
              </Row>
            ))}
          </ul>
        )}
      </Panel>

      {(s.ops ?? []).length > 0 && (
        <Panel title="Your Solana activity">
          <ul className="font-body grid gap-1 text-sm">
            {s.ops!.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-2 text-white/80">
                <span className="text-white">{ACTION_LABEL[o.action] ?? o.action}</span>
                {o.def && <span>{name({ def: o.def, rarity: o.rarity ?? 0 })}</span>}
                {o.lamports && <span className="tabular-nums">{formatSol(o.lamports)}</span>}
                <span className={o.status === "done" ? "text-zooa-lime" : o.status === "sent" ? "text-amber-300" : "text-rose-300"}>{o.status}</span>
                {o.explorer && (
                  <a href={o.explorer} target="_blank" rel="noreferrer" className="text-sky-300 underline">
                    tx
                  </a>
                )}
                {o.error && <span className="text-rose-300">{o.error}</span>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </Shell>
  );
}

function name(it: { def: string; rarity: number }): string {
  const d = describeItem({ def: it.def, rarity: it.rarity });
  return `${d.rarityName} ${d.name}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 md:px-6">
      <p className="text-xs uppercase tracking-[0.25em] text-white/70">Solana</p>
      <h1 className="toon-text text-4xl tracking-wide text-zooa-lime md:text-5xl">On chain</h1>
      {children}
    </main>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="toon-panel bg-[#161b28]/95 p-5">
      <h2 className="toon-text-thin mb-3 text-2xl tracking-wide text-white">{title}</h2>
      {children}
    </section>
  );
}

function Row({ def, rarity, dur, sub, children }: { def: string; rarity: number; dur: number; sub: React.ReactNode; children: React.ReactNode }) {
  const d = describeItem({ def, rarity });
  return (
    <li className="flex items-center gap-3 rounded-2xl border-2 border-black bg-black/25 p-2.5">
      <ItemCard def={def} rarity={rarity} dur={dur} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm tracking-wide text-white">{d.name}</p>
        <p className="font-body truncate text-xs text-white/70">
          <span style={{ color: d.color }}>{d.rarityName}</span> · {Math.round(dur)}% · {sub}
        </p>
      </div>
      {children}
    </li>
  );
}
