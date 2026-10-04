"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAP_GEN_VERSION, MAP_IDS, generateMap, type MapData, type MapId } from "@extract/shared";
import type { AdminReplay, AdminReplayChunkInfo } from "@/lib/admin/replay";
import {
  EVENT_CATS,
  SPEEDS,
  STATUS_LABEL,
  advanceClock,
  chunkPos,
  clampView,
  describeEvent,
  entsAt,
  eventCat,
  eventFocus,
  eventsBetween,
  fitView,
  fmtBytes,
  fmtClock,
  fmtUtc,
  pickEntity,
  replayStatus,
  subjectKeyOf,
  subjectPos,
  timelineGaps,
  visibleEvents,
  wallTime,
  zoomAt,
  type ChunkMeta,
  type EntView,
  type EventCat,
  type NotableEvent,
  type Speed,
  type View,
} from "@/lib/admin/replay-view";
import { HIT_FLASH_MS, TRACER_MS, drawScene } from "@/lib/admin/replay-view-draw";
import { ReplayLoader } from "@/lib/admin/replay-view-load";
import { ReplaySidePanel, type SubjectOption } from "./replay-side-panel";
import { ReplayTimeline, type TimelineTick } from "./replay-timeline";

/** Time label / side panel refresh while playing (the canvas itself redraws every frame). */
const UI_EVERY_MS = 100;
/** A running shard adds a chunk about every minute: re-read the index this often. */
const LIVE_POLL_MS = 30_000;
/** Jumping to an event lands this long before it. */
const EVENT_LEAD_MS = 2_000;
/** Zoom an event jump gives at least (a fight is readable). */
const EVENT_SCALE = 0.16;

const STATUS_CLS = {
  done: "bg-white/[0.07] text-white/60",
  live: "bg-emerald-400/15 text-emerald-300",
  cut: "bg-amber-400/15 text-amber-300",
} as const;

/**
 * Admin replay viewer (/admin/replays/:matchId): the static map from the shared generator, the
 * runtimes at the playhead (interpolated between 200 ms frames), a scrubber with play / pause and
 * 1× / 4× / 16×, a subject filter (one player, followed by the camera, or a boss) and an events
 * list that jumps the timeline. Chunks are fetched by range as the playhead needs them, then the
 * rest in the background so the events list is complete.
 */
export function ReplayViewer({ replay: replay0, chunks: chunks0, now }: { replay: AdminReplay; chunks: AdminReplayChunkInfo[]; now: number }) {
  const [replay, setReplay] = useState(replay0);
  const [index, setIndex] = useState<ChunkMeta[]>(() => sortIndex(chunks0));
  const loaderRef = useRef<ReplayLoader | null>(null);
  const [ver, setVer] = useState(0);
  const [map, setMap] = useState<MapData | null>(null);
  const mapError = MAP_IDS.includes(replay.mapId as MapId) ? null : `Карта «${replay.mapId}» неизвестна этой сборке.`;

  const start = index[0]?.startMs ?? 0;
  const end = Math.max(start, replay.lastMs, index.at(-1)?.endMs ?? 0);
  const startedAtMs = useMemo(() => Date.parse(replay.startedAt), [replay.startedAt]);

  const [tUi, setTUi] = useState(start);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(4);
  const [subjectKey, setSubjectKey] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [cats, setCats] = useState<ReadonlySet<EventCat>>(() => new Set(EVENT_CATS));

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tRef = useRef(start);
  const viewRef = useRef<View | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
  const entsRef = useRef<EntView[]>([]);
  const hoverRef = useRef<number | null>(null);
  const playingRef = useRef(false);
  const speedRef = useRef<Speed>(4);
  const endRef = useRef(end);
  const followRef = useRef(true);
  const rafRef = useRef(0);
  const lastNowRef = useRef(0);
  const lastUiRef = useRef(0);
  const frameRef = useRef<(now: number) => void>(() => {});
  endRef.current = end;
  speedRef.current = speed;
  followRef.current = follow;

  // ------------------------------------------------------------------ data
  useEffect(() => {
    const loader = new ReplayLoader(replay0.matchId, sortIndex(chunks0), () => {
      setVer((v) => v + 1);
      requestDraw();
    });
    loaderRef.current = loader;
    setVer((v) => v + 1);
    loader.setPlayhead(tRef.current);
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
    // One loader per replay page; the live poll feeds it new index rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay0.matchId]);

  useEffect(() => {
    if (mapError) return;
    // ~0.1 s of generation: after the first paint.
    const id = window.setTimeout(() => setMap(generateMap(replay.mapId as MapId)), 30);
    return () => window.clearTimeout(id);
  }, [replay.mapId, mapError]);

  // A shard still writing: poll its index until it ends or goes stale (status by the poll's clock).
  const [clock, setClock] = useState(now);
  const live = replayStatus(replay, clock) === "live";
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const id = window.setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/admin/replays/${encodeURIComponent(replay.matchId)}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const body = (await res.json()) as { replay: AdminReplay; chunks: AdminReplayChunkInfo[] };
        setClock(Date.now());
        setReplay(body.replay);
        const next = sortIndex(body.chunks);
        setIndex(next);
        loaderRef.current?.setIndex(next);
      } catch {
        // The next poll tries again.
      }
    }, LIVE_POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [replay.matchId, live]);

  const loader = loaderRef.current;
  // Everything derived from the loaded chunks, recomputed when a chunk lands (ver).
  const data = useMemo(() => {
    const m = loaderRef.current?.model ?? null;
    return {
      model: m,
      players: m?.players() ?? [],
      bosses: m ? [...m.spawns.values()].filter((s) => s.kind === "boss").map<SubjectOption>((s) => ({ key: subjectKeyOf(s), name: m.name(s.r) })) : [],
      events: m?.events ?? [],
      loaded: new Set(loaderRef.current?.frames.keys() ?? []),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ver]);
  const { model, players, bosses, events: allEvents } = data;
  const subject = useMemo(() => (subjectKey && model ? model.subject(subjectKey) : null), [subjectKey, model, data]);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const events = useMemo(() => visibleEvents(allEvents, subject, cats), [allEvents, subject, cats]);
  const catCounts = useMemo(() => {
    const all = new Set(EVENT_CATS);
    const out = Object.fromEntries(EVENT_CATS.map((c) => [c, 0])) as Record<EventCat, number>;
    for (const e of visibleEvents(allEvents, subject, all)) out[eventCat(e)!]++;
    return out;
  }, [allEvents, subject]);
  const ticks = useMemo<TimelineTick[]>(() => events.map((e) => ({ t: e.t, cat: eventCat(e)! })), [events]);
  const gaps = useMemo(() => timelineGaps(index, end), [index, end]);
  const loadedRanges = useMemo(() => index.filter((c) => data.loaded.has(c.seq)).map((c) => [c.startMs, c.endMs] as const), [index, data]);
  const extractName = useCallback((id: string) => map?.extracts.find((e) => e.id === id)?.name ?? id, [map]);
  const describe = useCallback(
    (e: NotableEvent) => (data.model ? describeEvent(e, (r) => data.model!.name(r), extractName) : ""),
    [data, extractName],
  );
  const killerName = useCallback(
    (r: number) => {
      const d = data.model?.deaths.find((x) => x.r === r);
      return d && d.killer >= 0 ? data.model!.name(d.killer) : null;
    },
    [data],
  );

  // ------------------------------------------------------------------ drawing
  const draw = () => {
    const canvas = canvasRef.current;
    const ld = loaderRef.current;
    const { w, h, dpr } = sizeRef.current;
    if (!canvas || !ld || !map || w === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let v = viewRef.current ?? fitView(map.width, map.height, w, h);
    const t = tRef.current;
    const pos = chunkPos(ld.index, t);
    const cur = pos >= 0 ? ld.frames.get(ld.index[pos]!.seq) : undefined;
    const nextMeta = pos >= 0 ? ld.index[pos + 1] : undefined;
    const next = nextMeta ? (ld.frames.get(nextMeta.seq) ?? null) : null;
    const ents = cur ? entsAt(cur, next, t) : [];
    entsRef.current = ents;
    const sub = subjectRef.current;
    if (followRef.current && sub) {
      const p = subjectPos(sub, ents, ld.model.leaves, t);
      if (p) v = clampView({ ...v, cx: p.x, cy: p.y }, map.width, map.height, w, h);
    }
    viewRef.current = v;
    const wipeAt = ld.model.wipeAt;
    const banner = !cur
      ? pos < 0
        ? t >= start && t <= end && ld.index.length > 0
          ? "Нет записи за этот отрезок"
          : ld.index.length === 0
            ? "В этом повторе ещё нет кусков"
            : null
        : ld.isFailed(ld.index[pos]!.seq)
          ? "Кусок не загрузился"
          : "Загрузка…"
      : wipeAt !== null && t >= wipeAt
        ? "Вайп: карта закрылась"
        : null;
    drawScene(ctx, {
      map,
      view: v,
      w,
      h,
      t,
      ents,
      deaths: eventsBetween(ld.model.deaths, -1, t),
      shots: cur ? eventsBetween(cur.shots, t - TRACER_MS, t) : [],
      hits: cur ? eventsBetween(cur.hits, t - HIT_FLASH_MS, t) : [],
      spawns: ld.model.spawns,
      subject: sub,
      hover: hoverRef.current,
      banner,
    });
  };

  frameRef.current = (nowMs: number) => {
    rafRef.current = 0;
    if (playingRef.current) {
      const dt = lastNowRef.current ? nowMs - lastNowRef.current : 0;
      lastNowRef.current = nowMs;
      // Buffering: the clock waits while the chunk under the playhead is still loading.
      const ld = loaderRef.current;
      const pos = ld ? chunkPos(ld.index, tRef.current) : -1;
      const seqAt = pos >= 0 ? ld!.index[pos]!.seq : -1;
      const waiting = seqAt >= 0 && !ld!.frames.has(seqAt) && !ld!.isFailed(seqAt);
      const r = waiting ? { t: tRef.current, ended: false } : advanceClock(tRef.current, dt, speedRef.current, endRef.current);
      tRef.current = r.t;
      loaderRef.current?.setPlayhead(r.t);
      if (r.ended) {
        playingRef.current = false;
        setPlaying(false);
        setTUi(r.t);
      } else {
        if (nowMs - lastUiRef.current >= UI_EVERY_MS) {
          lastUiRef.current = nowMs;
          setTUi(r.t);
        }
        rafRef.current = requestAnimationFrame((n) => frameRef.current(n));
      }
    } else {
      lastNowRef.current = 0;
    }
    draw();
  };

  function requestDraw() {
    if (!rafRef.current) rafRef.current = requestAnimationFrame((n) => frameRef.current(n));
  }

  useEffect(() => {
    requestDraw();
  });

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    },
    [],
  );

  // Canvas size (device pixels) follows its box.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      sizeRef.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (map && w > 0) viewRef.current = viewRef.current ? clampView(viewRef.current, map.width, map.height, w, h) : fitView(map.width, map.height, w, h);
      requestDraw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // ------------------------------------------------------------------ controls
  const seek = useCallback(
    (t: number) => {
      const c = Math.max(start, Math.min(end, t));
      tRef.current = c;
      setTUi(c);
      loaderRef.current?.setPlayhead(c);
      requestDraw();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [start, end],
  );

  const setPlay = useCallback(
    (on: boolean) => {
      if (on && tRef.current >= endRef.current) seek(start);
      playingRef.current = on;
      lastNowRef.current = 0;
      setPlaying(on);
      requestDraw();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seek, start],
  );

  const zoomBy = (factor: number, sx?: number, sy?: number) => {
    const { w, h } = sizeRef.current;
    if (!map || !viewRef.current) return;
    const following = followRef.current && subjectRef.current;
    viewRef.current = zoomAt(viewRef.current, w, h, following || sx === undefined ? w / 2 : sx, following || sy === undefined ? h / 2 : sy!, factor, map.width, map.height);
    requestDraw();
  };

  const fitAll = () => {
    const { w, h } = sizeRef.current;
    if (!map) return;
    setFollow(false);
    followRef.current = false;
    viewRef.current = fitView(map.width, map.height, w, h);
    requestDraw();
  };

  const chooseSubject = useCallback((key: string | null) => {
    setSubjectKey(key);
    if (key) {
      setFollow(true);
      followRef.current = true;
      const { w, h } = sizeRef.current;
      // Following from the whole-map view: come in close enough to see the fight.
      if (map && viewRef.current && viewRef.current.scale < EVENT_SCALE) viewRef.current = clampView({ ...viewRef.current, scale: EVENT_SCALE }, map.width, map.height, w, h);
    }
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  const toggleFollow = useCallback((on: boolean) => {
    setFollow(on);
    followRef.current = on;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onEvent = useCallback(
    (e: NotableEvent) => {
      seek(e.t - EVENT_LEAD_MS);
      const ld = loaderRef.current;
      if (!ld || !map) return;
      if (followRef.current && subjectRef.current) return;
      const p = eventFocus(e, ld.model.leaves);
      if (p && viewRef.current) {
        const { w, h } = sizeRef.current;
        viewRef.current = clampView({ cx: p.x, cy: p.y, scale: Math.max(EVENT_SCALE, viewRef.current.scale) }, map.width, map.height, w, h);
        requestDraw();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seek, map],
  );

  const toggleCat = useCallback((c: EventCat) => {
    setCats((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  }, []);

  // Pointer: drag pans (and stops following), wheel zooms at the cursor, a click picks a runtime.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let down: { x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null = null;
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !viewRef.current) return;
      canvas.setPointerCapture(e.pointerId);
      const p = local(e);
      down = { x: p.x, y: p.y, cx: viewRef.current.cx, cy: viewRef.current.cy, moved: false, id: e.pointerId };
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      const v = viewRef.current;
      if (down && v && map) {
        const dx = p.x - down.x;
        const dy = p.y - down.y;
        if (!down.moved && dx * dx + dy * dy > 16) {
          down.moved = true;
          hoverRef.current = null;
          if (followRef.current) {
            followRef.current = false;
            setFollow(false);
          }
          canvas.style.cursor = "grabbing";
        }
        if (down.moved) {
          const { w, h } = sizeRef.current;
          viewRef.current = clampView({ ...v, cx: down.cx - dx / v.scale, cy: down.cy - dy / v.scale }, map.width, map.height, w, h);
          requestDraw();
        }
        return;
      }
      if (!v) return;
      const { w, h } = sizeRef.current;
      const hit = pickEntity(entsRef.current, v, w, h, p.x, p.y);
      const r = hit ? hit.r : null;
      if (r !== hoverRef.current) {
        hoverRef.current = r;
        canvas.style.cursor = r !== null ? "pointer" : "grab";
        requestDraw();
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.pointerId !== down.id) return;
      const wasClick = !down.moved;
      down = null;
      canvas.style.cursor = hoverRef.current !== null ? "pointer" : "grab";
      if (!wasClick || !viewRef.current) return;
      const p = local(e);
      const { w, h } = sizeRef.current;
      const hit = pickEntity(entsRef.current, viewRef.current, w, h, p.x, p.y);
      const sp = hit ? loaderRef.current?.model.spawns.get(hit.r) : undefined;
      if (hit) chooseSubject(sp ? subjectKeyOf(sp) : `r:${hit.r}`);
    };
    const onLeave = () => {
      if (hoverRef.current !== null) {
        hoverRef.current = null;
        requestDraw();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      hoverRef.current = null;
      zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), p.x, p.y);
    };
    const onDbl = (e: MouseEvent) => {
      const p = local(e);
      zoomBy(2, p.x, p.y);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDbl);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, chooseSubject]);

  // Keyboard: space, arrows, 1/2/3, F, 0, +/-.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const k = e.key;
      if (k === " " || k === "k" || k === "K") {
        // Space is the player's key even on a focused button (Enter still presses buttons).
        e.preventDefault();
        setPlay(!playingRef.current);
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        seek(tRef.current + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 30_000 : 5_000));
      } else if (k === "1" || k === "2" || k === "3") {
        setSpeed(SPEEDS[Number(k) - 1]!);
      } else if (k === "f" || k === "F") {
        if (subjectRef.current) toggleFollow(!followRef.current);
      } else if (k === "0") {
        fitAll();
      } else if (k === "+" || k === "=") {
        zoomBy(1.5);
      } else if (k === "-" || k === "_") {
        zoomBy(1 / 1.5);
      } else if (k === "Escape") {
        chooseSubject(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek, setPlay, toggleFollow, chooseSubject, map]);

  // ------------------------------------------------------------------ render
  const status = replayStatus(replay, clock);
  const total = index.length;
  const loaded = loader?.loaded ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="min-w-0">
          <Link href="/admin/replays" className="text-xs text-white/50 underline decoration-white/25 underline-offset-2 hover:text-white">
            ← Все повторы
          </Link>
          <h1 className="mt-0.5 text-xl font-bold md:text-2xl">
            Карта №{replay.mapNumber} · шард {replay.shard}
            <span className={`ml-2 inline-block rounded-full px-2 py-0.5 align-middle text-xs font-semibold ${STATUS_CLS[status]}`}>{STATUS_LABEL[status]}</span>
          </h1>
        </div>
        <p className="text-xs leading-relaxed text-white/50">
          {fmtUtc(startedAtMs)} · записано {fmtClock(replay.lastMs)} · входов {replay.entries} · {fmtBytes(replay.bytes)} · кусков {replay.chunks} · генератор карты v{MAP_GEN_VERSION}
          <br />
          <span className="font-mono text-white/35">{replay.matchId}</span>
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-2">
          <div ref={wrapRef} className="relative h-[calc(100dvh-19rem)] min-h-[380px] overflow-hidden rounded-xl border border-white/10 bg-[#0d1117]">
            <canvas ref={canvasRef} className="block cursor-grab touch-none" aria-label="Карта повтора" />
            {!map ? (
              <div className="absolute inset-0 grid place-items-center text-sm text-white/55">{mapError ?? "Строю карту…"}</div>
            ) : null}
            <div className="pointer-events-none absolute left-2 top-2 rounded-lg bg-black/60 px-2 py-1.5 text-[0.7rem] leading-relaxed text-white/75">
              <Legend />
            </div>
            <div className="absolute right-2 top-2 flex flex-col gap-1">
              <MapButton label="Приблизить (+)" onClick={() => zoomBy(1.5)}>
                +
              </MapButton>
              <MapButton label="Отдалить (−)" onClick={() => zoomBy(1 / 1.5)}>
                −
              </MapButton>
              <MapButton label="Вся карта (0)" onClick={fitAll}>
                ⤢
              </MapButton>
            </div>
            <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-[0.7rem] tabular-nums text-white/60">
              Загружено {loaded}/{total} · {fmtBytes(loader?.bytes ?? 0)}
              {loader?.error ? <span className="text-amber-300"> · ошибка: {loader.error}</span> : null}
            </div>
            {loader && loader.failedCount > 0 ? (
              <button
                type="button"
                onClick={() => loader.retry()}
                className="absolute bottom-2 right-2 min-h-[32px] rounded-md bg-amber-400/90 px-3 text-xs font-bold text-black"
              >
                Повторить загрузку
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPlay(!playing)}
              aria-label={playing ? "Пауза" : "Играть"}
              className="inline-flex h-10 w-12 items-center justify-center rounded-lg bg-zooa-lime text-black"
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <div className="flex rounded-lg bg-white/[0.06] p-0.5" role="group" aria-label="Скорость">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={speed === s}
                  onClick={() => setSpeed(s)}
                  className={`h-9 rounded-md px-3 text-sm font-semibold tabular-nums ${speed === s ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
                >
                  {s}×
                </button>
              ))}
            </div>
            <span className="text-sm font-semibold tabular-nums">
              {fmtClock(tUi)} <span className="text-white/40">/ {fmtClock(end)}</span>
            </span>
            <span className="text-xs tabular-nums text-white/45">{wallTime(startedAtMs, tUi)}</span>
            <span className="ml-auto hidden text-[0.7rem] text-white/35 xl:inline">
              Пробел — пауза · ←/→ 5 с (Shift 30 с) · 1/2/3 скорость · колесо — зум · клик по точке — выбрать · Esc — все
            </span>
          </div>
          <ReplayTimeline start={start} end={end} t={tUi} loaded={loadedRanges} gaps={gaps} ticks={ticks} onSeek={seek} />
        </div>

        <ReplaySidePanel
          t={tUi}
          playing={playing}
          startedAtMs={startedAtMs}
          players={players}
          bosses={bosses}
          subjectKey={subjectKey}
          onSubject={chooseSubject}
          follow={follow}
          onFollow={toggleFollow}
          events={events}
          catCounts={catCounts}
          cats={cats}
          onToggleCat={toggleCat}
          describe={describe}
          onEvent={onEvent}
          killerName={killerName}
        />
      </div>
    </div>
  );
}

function sortIndex(chunks: readonly ChunkMeta[]): ChunkMeta[] {
  return [...chunks].sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
}

function MapButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-lg bg-black/65 text-lg font-bold leading-none text-white hover:bg-black/80"
    >
      {children}
    </button>
  );
}

function Legend() {
  const dot = (bg: string, extra = "") => <span className={`inline-block h-2.5 w-2.5 rounded-full align-[-1px] ${extra}`} style={{ background: bg }} />;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="leading-4">
        {dot("#4dabf7")} игрок (цвет из палитры) · {dot("#ff3b3b")} босс
      </span>
      <span className="leading-4">
        {dot("#a3a9b0")} NPC · {dot("#5d636b")} NPC спит · <span className="font-bold text-white/80">×</span> погиб
      </span>
      <span className="leading-4">
        <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[#3ee07a] align-[-1px]" /> эвакуация ·{" "}
        <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-white/80 align-[-1px]" /> без связи
      </span>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" />
    </svg>
  );
}
