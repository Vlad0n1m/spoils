import { decodeReplayChunk } from "@extract/shared";
import { ReplayModel, compactChunk, planFetch, type ChunkMeta, type FrameStore } from "./replay-view";

/**
 * Browser-side chunk loader of the admin replay viewer: asks GET /api/admin/replays/:id/chunks for
 * the ranges planFetch picks (the playhead's chunk and the next first, then the rest so the events
 * list fills in), one request at a time; inflates each chunk (DecompressionStream "deflate-raw"),
 * decodes it (@extract/shared decodeReplayChunk), packs its frames (FrameStore) and merges its
 * events into the ReplayModel. A failed range is skipped until retry().
 */

export interface ChunkPage {
  chunks: Array<ChunkMeta & { data: string }>;
  next: number | null;
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ReplayLoader {
  readonly model = new ReplayModel();
  readonly frames = new Map<number, FrameStore>();
  private readonly inflight = new Set<number>();
  private readonly failed = new Set<number>();
  private readonly abort = new AbortController();
  private busy = false;
  private disposed = false;
  private playT = 0;
  index: ChunkMeta[];
  /** The last load error (shown with a retry button), or null. */
  error: string | null = null;
  /** Compressed bytes received. */
  bytes = 0;

  constructor(
    private readonly matchId: string,
    index: readonly ChunkMeta[],
    private readonly onChange: () => void,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.index = [...index].sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
  }

  get loaded(): number {
    return this.frames.size;
  }

  get failedCount(): number {
    return this.failed.size;
  }

  /** This chunk's load failed (shown until retry()). */
  isFailed(seq: number): boolean {
    return this.failed.has(seq);
  }

  get rows(): number {
    let n = 0;
    for (const f of this.frames.values()) n += f.rows;
    return n;
  }

  /** New chunk index (a running shard keeps adding chunks). */
  setIndex(index: readonly ChunkMeta[]): void {
    this.index = [...index].sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
    void this.pump();
  }

  setPlayhead(t: number): void {
    this.playT = t;
    void this.pump();
  }

  retry(): void {
    this.failed.clear();
    this.error = null;
    this.onChange();
    void this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
  }

  private skip = (seq: number): boolean => this.frames.has(seq) || this.inflight.has(seq) || this.failed.has(seq);

  private async pump(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    try {
      for (;;) {
        if (this.disposed) return;
        const plan = planFetch(this.index, this.skip, this.playT, { ahead: 1, batch: 4 });
        if (!plan) return;
        await this.load(plan.from, plan.to, plan.seqs);
      }
    } finally {
      this.busy = false;
    }
  }

  private async load(from: number, to: number, seqs: number[]): Promise<void> {
    for (const s of seqs) this.inflight.add(s);
    try {
      const res = await this.fetchImpl(`/api/admin/replays/${encodeURIComponent(this.matchId)}/chunks?from=${from}&to=${to}`, {
        cache: "no-store",
        signal: this.abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as ChunkPage;
      for (const c of page.chunks) {
        if (this.disposed) return;
        const packed = base64ToBytes(c.data);
        this.bytes += packed.length;
        const data = decodeReplayChunk(await inflateRaw(packed));
        this.model.add(data);
        this.frames.set(c.seq, compactChunk(data));
        this.inflight.delete(c.seq);
        this.onChange();
        // Let a frame paint between chunks (decoding a busy minute takes a few ms).
        await new Promise((r) => setTimeout(r, 0));
      }
      // Asked for but not returned (deleted by retention meanwhile): do not ask again.
      for (const s of seqs) if (this.inflight.delete(s)) this.failed.add(s);
    } catch (e) {
      if (this.disposed) return;
      for (const s of seqs) if (this.inflight.delete(s)) this.failed.add(s);
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.onChange();
  }
}
