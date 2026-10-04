/**
 * Plug-in systems for the renderer (v2). Audio, weather, sound visualization, fog, inventory glue
 * and immersion effects are built as independent modules that implement GameSystem; the renderer
 * owns the Pixi app, the camera and the room, creates the systems from SYSTEM_FACTORIES and drives
 * them. A system never edits renderer.ts and never talks to another system directly — it reads the
 * shared GameContext and reacts to frames, per-tick events and HUD changes.
 */

import type { Application, Container } from "pixi.js";
import type { Room } from "colyseus.js";
import type { BattleState, EventsMsg, MapData, Player, SelfState } from "@extract/shared";
import type { PartyMateView } from "./party";

/** Named layers a system may draw into (created by the renderer, z-ordered bottom → top). */
export interface GameLayers {
  /** World space, under everything dynamic (decals, puddles, ground fx). */
  ground: Container;
  /** World space, between entities and canopies (impacts, casings, tracers). */
  worldFx: Container;
  /** World space, above canopies/bushes (rain splashes, weather particles that must cover the map). */
  worldTop: Container;
  /** Screen space, above the world and the fog/darkness pass (vignette, sound ring, damage arcs). */
  screen: Container;
}

/** Camera in world units; zoom = screen px per world px. */
export interface CameraView {
  x: number;
  y: number;
  zoom: number;
  /** Screen size in CSS px. */
  width: number;
  height: number;
}

/** Everything a system may read. Getters are cheap and always reflect the current frame. */
export interface GameContext {
  app: Application;
  room: Room<BattleState>;
  layers: GameLayers;
  /** Static map (generateMap(state.mapId)); null until the state arrived. */
  map(): MapData | null;
  state(): BattleState | null;
  /** The local player's self key ("p<rosterIndex>"), known after S2C.JOINED. */
  selfKey(): string | null;
  self(): SelfState | null;
  /** Public entry of the local player (may be absent while dead/extracted). */
  me(): Player | null;
  /** Where the local player is drawn (predicted), in world units. */
  selfPos(): { x: number; y: number };
  /** Local aim angle in radians (mouse). */
  aim(): number;
  camera(): CameraView;
  /** Match clock in ms, extrapolated between patches. */
  clockMs(): number;
  /** World → screen (CSS px). */
  toScreen(x: number, y: number): { x: number; y: number };
  /**
   * This frame an overlay (inventory, search panel, full map) owns the mouse: no fire, aim and
   * camera look-ahead frozen.
   */
  inputBlocked(): boolean;
  /**
   * Where another player was last drawn on this client and when (performance.now(); `at` = now
   * while they are still in view). Survives their removal from the state — a dead client's view
   * drops every other player before the kill event arrives. Null if never seen.
   */
  lastSeen(id: string): { x: number; y: number; at: number } | null;
  /**
   * The local player's party mates from S2C.PARTY (party.ts PartyTracker), smoothed; empty when
   * solo. Allies are shown through fog by design. The array is reused every frame: do not keep it.
   */
  partyMates?(): readonly PartyMateView[];
  /**
   * Weapons v2: the touch grenade button is being dragged — direction and 0..1 of the throw range
   * (grenades.ts draws the throw preview); null otherwise.
   */
  grenadeAim?(): { angle: number; frac: number } | null;
}

export interface GameSystem {
  /** Stable id, used for debugging and the F3 perf overlay. */
  readonly id: string;
  /** Called once after the state and map are available. */
  init?(ctx: GameContext): void | Promise<void>;
  /** Every animation frame; dtMs is the frame delta. Keep it allocation-free. */
  frame?(dtMs: number, ctx: GameContext): void;
  /** Once per received S2C.EV batch (one per server tick). */
  onEvents?(ev: EventsMsg, ctx: GameContext): void;
  /** True while this system's own canvas overlay owns the mouse (e.g. the full map). */
  isInputBlocked?(): boolean;
  /** A UI command that has no key of its own here (the touch MAP button). True when handled. */
  command?(name: SystemCommand): boolean;
  /** Screen resize. */
  resize?(width: number, height: number, ctx: GameContext): void;
  /** Release textures, audio nodes, listeners. Must be safe to call twice. */
  dispose(): void;
}

/** Commands the renderer forwards to systems (GameSystem.command). */
export type SystemCommand = "toggleMap";

export type SystemFactory = () => GameSystem;
