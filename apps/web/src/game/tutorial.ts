/**
 * First-raid tutorial (alpha, docs/GAME_DESIGN.md §18f): the hint overlay's step machine. The
 * server spawns a first-time raider next to a quiet T1 container with a marauder post nearby
 * (JoinTicket.tutorial, game-server spawn.ts pickTutorialSpawn); the overlay walks them through
 * move → aim → search → kill → heal → extract. Every step completes on a real event read from
 * the HUD snapshot (position, aim, an open search, an NPC kill, a heal channel, the extract
 * channel), never on a click. Pure: battle-screen feeds snapshots, tests feed fakes.
 * The "Finish the tutorial" pass task itself is settled by the web from the exit report
 * (extract + a container + a kill), so skipping the hints never blocks it.
 */

export const TUTORIAL_STEPS = ["move", "aim", "search", "kill", "heal", "extract", "done"] as const;
export type TutorialStep = (typeof TUTORIAL_STEPS)[number];

/** Walk this far from the first seen position to finish "move". */
export const TUTORIAL_MOVE_PX = 140;
/** Turn the aim this much (radians, ≈ 46°) from where it pointed when "aim" began. */
export const TUTORIAL_AIM_RAD = 0.8;
/** "heal" with full HP (nothing to heal) or no meds passes after this long: there is no wound to treat. */
export const TUTORIAL_UNHURT_MS = 6_000;

export interface TutorialSignals {
  /** Wall-clock ms (performance.now or Date.now). */
  now: number;
  pose: { x: number; y: number; aim: number } | null;
  alive: boolean;
  /** A container / body search is open or opening. */
  searching: boolean;
  /** NPC kills this raid (marauders + guards + bosses). */
  npcKills: number;
  hp: number;
  maxHp: number;
  /** A heal channel is running. */
  healing: boolean;
  /** Bandages + medkits carried. */
  meds: number;
  /** The extract channel started, or the raider extracted. */
  extracting: boolean;
}

export interface TutorialState {
  step: TutorialStep;
  /** Where "move" started. */
  origin: { x: number; y: number } | null;
  /** Aim when "aim" started. */
  aim0: number | null;
  /** When "heal" was first seen with nothing to heal (null = hurt or not there yet). */
  unhurtSince: number | null;
  /** The heal step passed without a heal (unhurt). */
  healSkipped: boolean;
}

export function initialTutorial(): TutorialState {
  return { step: "move", origin: null, aim0: null, unhurtSince: null, healSkipped: false };
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function next(step: TutorialStep): TutorialStep {
  const i = TUTORIAL_STEPS.indexOf(step);
  return TUTORIAL_STEPS[Math.min(TUTORIAL_STEPS.length - 1, i + 1)]!;
}

/**
 * One snapshot applied: at most one step completes per call (the overlay shows each "done" tick).
 * A dead raider stays where they were (the outcome screen takes over). Steps:
 *   move    – pose ≥ TUTORIAL_MOVE_PX from the first pose
 *   aim     – aim turned ≥ TUTORIAL_AIM_RAD from the aim at the step's start
 *   search  – a search is open
 *   kill    – npcKills ≥ 1 (a kill made earlier counts)
 *   heal    – a heal channel runs; or full HP / no meds for TUTORIAL_UNHURT_MS (healSkipped)
 *   extract – the extract channel started
 */
export function advanceTutorial(s: TutorialState, sig: TutorialSignals): TutorialState {
  if (s.step === "done" || !sig.alive) return s;
  switch (s.step) {
    case "move": {
      if (!sig.pose) return s;
      if (!s.origin) return { ...s, origin: { x: sig.pose.x, y: sig.pose.y } };
      const d = Math.hypot(sig.pose.x - s.origin.x, sig.pose.y - s.origin.y);
      return d >= TUTORIAL_MOVE_PX ? { ...s, step: "aim", aim0: sig.pose.aim } : s;
    }
    case "aim": {
      if (!sig.pose) return s;
      if (s.aim0 === null) return { ...s, aim0: sig.pose.aim };
      return angleDiff(sig.pose.aim, s.aim0) >= TUTORIAL_AIM_RAD ? { ...s, step: "search" } : s;
    }
    case "search":
      return sig.searching ? { ...s, step: "kill" } : s;
    case "kill":
      return sig.npcKills >= 1 ? { ...s, step: "heal" } : s;
    case "heal": {
      if (sig.healing) return { ...s, step: "extract", unhurtSince: null };
      const nothing = sig.hp >= sig.maxHp || sig.meds <= 0;
      if (!nothing) return s.unhurtSince === null ? s : { ...s, unhurtSince: null };
      if (s.unhurtSince === null) return { ...s, unhurtSince: sig.now };
      return sig.now - s.unhurtSince >= TUTORIAL_UNHURT_MS ? { ...s, step: "extract", healSkipped: true, unhurtSince: null } : s;
    }
    case "extract":
      return sig.extracting ? { ...s, step: next(s.step) } : s;
  }
  return s;
}

/** The hint of `step`: title + one line, touch or desktop wording. */
export function tutorialHint(step: TutorialStep, touch: boolean, unhurt = false): { title: string; text: string } {
  switch (step) {
    case "move":
      return { title: "Move", text: touch ? "Drag the left stick to walk." : "Walk with W A S D." };
    case "aim":
      return {
        title: "Aim",
        text: touch
          ? "Drag the right stick to aim. Your gun fires by itself when an enemy is on the line."
          : "Aim with the mouse. Left click shoots.",
      };
    case "search":
      return {
        title: "Search the crate",
        text: touch ? "Walk up to the crate nearby and tap USE." : "Walk up to the crate nearby and press F.",
      };
    case "kill":
      return {
        title: "Kill the marauder",
        text: touch
          ? "A marauder holds a post close by. Point the right stick at him — auto-fire does the rest."
          : "A marauder holds a post close by. Aim at him and hold the left mouse button.",
      };
    case "heal":
      if (unhurt) return { title: "Heal", text: touch ? "Not hurt? Tap + (bandage) whenever you take a hit." : "Not hurt? Press 3 for a bandage whenever you take a hit." };
      return { title: "Heal", text: touch ? "Tap + to put on a bandage. Stand still while it works." : "Press 3 for a bandage (4: medkit). Stand still while it works." };
    case "extract":
      return {
        title: "Extract",
        text: touch
          ? "Follow the arrow to an extract and stand in the circle to get out with your loot."
          : "Follow the arrow to an extract and stand in the circle to get out with your loot.",
      };
    case "done":
      return { title: "You made it", text: "That's a raid. Your loot is safe once you're out." };
  }
}
