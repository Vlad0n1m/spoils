/**
 * Per-view patch isolation (security audit "StateView patch overflow").
 *
 * @colyseus/core 0.16.24 SchemaSerializer.applyPatches encodes the per-client views of one tick with
 * ONE shared iterator into Encoder.sharedBuffer, so all clients' view bytes of a tick share its
 * BUFFER_SIZE (NET.ENCODER_BUFFER_BYTES). @colyseus/schema 3.0.76 Encoder.encodeView never grows that
 * buffer (the resized buffer of its nested encode() is dropped), so the bytes past the end are lost:
 * one oversized view truncated the patches of every client encoded after it, and their decoders
 * desynced ("refId not found", stale HP) for good.
 *
 * encodeView returns a copy (Buffer.concat of the shared part and the view's bytes) before the next
 * client is encoded, so every view may start right after the shared part instead of after the
 * previous client's view. With that, a view can only ever spoil its own patch; `onOverflow` reports
 * it (the room disconnects that client, which rejoins with a fresh full state). ViewSync's per-tick
 * add budget (sim/views.ts VIEW_ADDS_PER_TICK) keeps honest views far below the buffer anyway.
 */

import type { StateView } from "@colyseus/schema";

interface Iterator {
  offset: number;
}

/** The part of @colyseus/schema's Encoder this wraps. */
export interface ViewEncoder {
  sharedBuffer: Buffer;
  encodeView(view: StateView, sharedOffset: number, it: Iterator, bytes?: Buffer): Buffer;
}

const WRAPPED = Symbol("isolatedViewPatches");

/** Wrap `encoder.encodeView` once. Returns false (and changes nothing) for an unexpected encoder. */
export function isolateViewPatches(encoder: unknown, onOverflow: (view: StateView, bytes: number) => void): boolean {
  const enc = encoder as (ViewEncoder & { [WRAPPED]?: true }) | null;
  if (!enc || typeof enc.encodeView !== "function") return false;
  if (enc[WRAPPED]) return true;
  const original = enc.encodeView;
  enc.encodeView = function (this: ViewEncoder, view: StateView, sharedOffset: number, it: Iterator, bytes?: Buffer): Buffer {
    it.offset = sharedOffset;
    const buf = bytes ?? this.sharedBuffer;
    const out = original.call(this, view, sharedOffset, it, bytes);
    if (it.offset > buf.byteLength) onOverflow(view, it.offset - sharedOffset);
    return out;
  };
  enc[WRAPPED] = true;
  return true;
}
