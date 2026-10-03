/**
 * Display objects for state entities (players, ground items, corpses, static containers,
 * extraction points) and the damage-direction arc. Views only draw; positions, visibility and
 * fog alpha are decided by the renderer each frame.
 *
 * v2: remote players are LOS-filtered by the server and come and go constantly, so PlayerView is
 * pooled and reusable (reset); it animates the public `act` flags (roll / reload / heal / loot /
 * extract) because the timers behind them are owner-only now, and shows the backpack level.
 * Ground items carry an item def id; icons not in the static Textures are loaded on demand.
 */

import { Container, Graphics, GraphicsContext, ImageSource, Sprite, Text, Texture } from "pixi.js";
import {
  ACT,
  CONTAINER_STATE,
  INPUT_DT_MS,
  PLAYER,
  RARITY_COLORS,
  ROLL,
  WEAPONS,
  WORLD,
  itemDef,
  type BossSpot,
  type ContainerSpot,
  type EventsMsg,
  type WeaponId,
} from "@extract/shared";
import {
  AMMO_TINT,
  CHEST_SIZE,
  COLORS,
  PLAYER_SPRITE_SIZE,
  WEAPON_GROUND_LENGTH,
  WEAPON_HELD_LENGTH,
  playerColor,
  type SpriteName,
  type Textures,
} from "./assets";
import { BOSS_COLOR, BOSS_SCALE, GUARD_SCALE, GUARD_TINT, MARAUDER_TINT, hpFraction, kindOfNpc, npcNameTag, npcRole, type NpcRole } from "./boss";
import { guardBadgeContext, npcBadgeContext } from "./boss-icons";
import { NPC_CORPSE_TINT, NPC_RING_COLOR, NPC_TAG_COLOR, type NpcRoleName } from "./npc-labels";
import { SnapshotBuffer } from "./prediction";
import type { GameContext, GameSystem } from "./systems";

function isWeaponId(w: string): w is WeaponId {
  return w in WEAPONS;
}

/** Size a sprite by width, keeping the texture aspect ratio. */
function fitWidth(s: Sprite, w: number) {
  const tw = s.texture.width || 1;
  s.width = w;
  s.height = (w * (s.texture.height || tw)) / tw;
}

const LABEL_FONT = "ui-rounded, 'Trebuchet MS', system-ui, sans-serif";

/* ---------------------------------------------------------------------------- icon cache */

/**
 * Textures for `/sprites/<name>.png` that are not part of the static Textures set (junk icons,
 * backpacks, corpse): loaded on first use, owned (and destroyed) by the cache. `get` returns null
 * until the image decoded, so callers retry next frame.
 */
export class IconCache {
  private readonly tex = new Map<string, Texture | null>();
  private destroyed = false;

  constructor(private readonly base = "/sprites/") {}

  get(name: string): Texture | null {
    const hit = this.tex.get(name);
    if (hit !== undefined) return hit;
    this.tex.set(name, null);
    if (typeof Image === "undefined") return null;
    const img = new Image();
    img.src = `${this.base}${name}.png`;
    img
      .decode()
      .then(() => {
        if (this.destroyed) return;
        this.tex.set(
          name,
          new Texture({ source: new ImageSource({ resource: img, autoGenerateMipmaps: true, scaleMode: "linear" }) }),
        );
      })
      .catch(() => {
        if (!this.destroyed) this.tex.set(name, Texture.EMPTY);
      });
    return null;
  }

  destroy(): void {
    this.destroyed = true;
    for (const t of this.tex.values()) if (t && t !== Texture.EMPTY && !t.destroyed) t.destroy(true);
    this.tex.clear();
  }
}

/** A static Textures entry when there is one (weapons, armor, meds, ammo), else the icon cache. */
function iconTexture(tex: Textures, icons: IconCache, name: string): Texture | null {
  const t = (tex as Partial<Record<string, Texture>>)[name];
  if (t && t !== Texture.EMPTY) return t;
  return icons.get(name);
}

/* ---------------------------------------------------------------------------- players */

/** Roll animation length (one full spin): ROLL.TICKS inputs. */
export const ROLL_ANIM_MS = ROLL.TICKS * INPUT_DT_MS;

/** Backpack sprite width on the player's back per level (1..3). */
const BACKPACK_W = [0, 28, 34, 40] as const;

/** Body spin while rolling: one turn over the roll, eased so it starts and ends gently. */
export function rollSpin(sinceMs: number): number {
  const t = Math.max(0, Math.min(1, sinceMs / ROLL_ANIM_MS));
  return 2 * Math.PI * (t * t * (3 - 2 * t));
}

/** Shared status icon geometry (one GraphicsContext each, reused by every PlayerView). */
let statusCtx: { heal: GraphicsContext; loot: GraphicsContext; extract: GraphicsContext } | null = null;
function statusContexts() {
  if (statusCtx) return statusCtx;
  const heal = new GraphicsContext()
    .circle(0, 0, 9).fill({ color: 0x1a1a1a, alpha: 0.85 })
    .rect(-2, -6, 4, 12).fill(0x5ee35a)
    .rect(-6, -2, 12, 4).fill(0x5ee35a);
  const loot = new GraphicsContext()
    .roundRect(-14, -6, 28, 12, 6).fill({ color: 0x1a1a1a, alpha: 0.85 })
    .circle(-7, 0, 2.6).fill(0xffd43b)
    .circle(0, 0, 2.6).fill(0xffd43b)
    .circle(7, 0, 2.6).fill(0xffd43b);
  const extract = new GraphicsContext().circle(0, 0, PLAYER.RADIUS + 10).stroke({ width: 3, color: COLORS.extractOpen, alpha: 0.9 });
  statusCtx = { heal, loot, extract };
  return statusCtx;
}

export class PlayerView {
  readonly root = new Container();
  /** Rotates with aim: backpack, weapon and body. */
  private readonly body = new Container();
  private readonly ring = new Graphics();
  private readonly weapon: Sprite;
  private readonly sprite: Sprite;
  private readonly backpack = new Sprite(Texture.EMPTY);
  private readonly label = new Container();
  private readonly name: Text;
  private readonly bars = new Graphics();
  /** Above the head: heal / loot status; around the feet: extract ring. */
  private readonly status = new Graphics(statusContexts().heal);
  private readonly extractRing = new Graphics(statusContexts().extract);
  /** Role badge left of the name tag: guard shield (v4) or marauder "NPC" chevron (v5). */
  private readonly badge = new Graphics(guardBadgeContext());
  readonly buffer = new SnapshotBuffer();

  private weaponId = "";
  private barsKey = "";
  private colorKey = "";
  /** NPC presentation (Player.role: boss / guard / marauder); null = a human player. */
  private role: NpcRole = null;
  private roleSet = false;
  private roleNick = "";
  private bossTexReady = false;
  /** Sprite size multiplier for the role (boss 1.4, guard 1.08). */
  private scaleK = 1;
  private statusY = -PLAYER.RADIUS - 44;
  private bpLevel = -1;
  private act = 0;
  private rollStartedAt = -Infinity;
  private statusKind: "" | "heal" | "loot" = "";
  /** Fog alpha (0..1), eased by the renderer. */
  alpha = 0;

  /** Last rendered position (used for effects anchoring, e.g. death bursts). */
  x = 0;
  y = 0;
  sessionId: string;

  constructor(
    private readonly tex: Textures,
    private readonly icons: IconCache,
    sessionId: string,
    readonly isSelf: boolean,
    nickname: string,
  ) {
    this.sessionId = sessionId;
    this.weapon = new Sprite(tex.pistol);
    this.weapon.anchor.set(0, 0.5);
    this.sprite = new Sprite(tex.player);
    this.sprite.anchor.set(0.5);
    this.sprite.width = PLAYER_SPRITE_SIZE;
    this.sprite.height = PLAYER_SPRITE_SIZE;
    this.backpack.anchor.set(0.5);
    // Top of the icon toward the head (+x), sitting on the back (−x).
    this.backpack.rotation = Math.PI / 2;
    this.backpack.visible = false;
    // The gun goes under the body so the arms/hands sit on top of its grip; the pack under both.
    this.body.addChild(this.backpack, this.weapon, this.sprite);

    this.name = new Text({
      text: nickname,
      style: {
        fontFamily: LABEL_FONT,
        fontSize: 13,
        fontWeight: "700",
        fill: 0xffffff,
        stroke: { color: 0x111111, width: 3 },
      },
      resolution: 2,
    });
    this.name.anchor.set(0.5, 1);
    this.name.position.set(0, -PLAYER.RADIUS - 16);
    this.badge.visible = false;
    this.label.addChild(this.name, this.bars, this.badge);
    this.label.visible = !isSelf;
    this.status.position.set(0, -PLAYER.RADIUS - 44);
    this.status.visible = false;
    this.extractRing.visible = false;

    this.root.addChild(this.extractRing, this.ring, this.body, this.label, this.status);
  }

  /** Reuse a pooled view for another (or the same, re-added) player. */
  reset(sessionId: string, nickname: string) {
    this.sessionId = sessionId;
    this.setRole(0, nickname);
    this.setNickname(nickname);
    this.buffer.clear();
    this.barsKey = "";
    this.act = 0;
    this.rollStartedAt = -Infinity;
    this.setStatus("");
    this.extractRing.visible = false;
    this.alpha = 0;
    this.root.alpha = 0;
  }

  setColor(index: number) {
    const key = `${index}|${this.role ?? ""}`;
    if (key === this.colorKey) return;
    this.colorKey = key;
    // NPCs take the fixed NPC palette, never a player colour index.
    const c = this.role ? NPC_RING_COLOR[this.role] : playerColor(index);
    const r = PLAYER.RADIUS * (this.role === "boss" ? 1.25 : 1) + 3;
    this.ring.clear();
    this.ring.circle(0, 0, r).fill({ color: c, alpha: this.role === "boss" ? 0.22 : 0.28 });
    this.ring.circle(0, 0, r).stroke({ width: this.role === "boss" ? 5 : 4, color: c, alpha: 0.95 });
    this.name.style.fill = this.isSelf ? 0xffffff : this.role ? NPC_TAG_COLOR[this.role] : c;
  }

  setNickname(nick: string) {
    // NPCs show their role tag (setRole) instead of the raw nickname.
    if (this.role) return;
    if (this.name.text !== nick) this.name.text = nick;
  }

  /**
   * Player.role (NPC_ROLE): a boss gets the boss sprite (bigger, red ring, "FOREMAN" tag, wide HP
   * bar), a guard a khaki tint, an amber ring and a shield badge, a marauder an olive tint, a khaki
   * ring, the "Marauder" tag and the NPC chevron badge. `bosses` (map.bosses) resolves the kind
   * when the nickname does not name it. Cheap when nothing changed; retries until boss.png loaded.
   */
  setRole(role: number, nickname: string, bosses?: readonly BossSpot[], x = 0, y = 0) {
    const r = npcRole(role);
    // Per-frame fast path: no allocation when nothing changed.
    if (this.roleSet && r === this.role && nickname === this.roleNick && (r !== "boss" || this.bossTexReady)) return;
    const bossTex = r === "boss" ? this.icons.get("boss") : null;
    const ready = !!bossTex && bossTex !== Texture.EMPTY;
    if (this.roleSet && r === this.role && nickname === this.roleNick && ready === this.bossTexReady) return;
    this.roleSet = true;
    this.roleNick = nickname;
    this.bossTexReady = ready;
    this.role = r;
    this.scaleK = r === "boss" ? BOSS_SCALE : r === "guard" ? GUARD_SCALE : 1;
    this.sprite.texture = r === "boss" && ready ? bossTex! : this.tex.player;
    // Until boss.png decoded, a red tint keeps the boss readable.
    this.sprite.tint =
      r === "guard" ? GUARD_TINT : r === "marauder" ? MARAUDER_TINT : r === "boss" && this.sprite.texture === this.tex.player ? 0xff8a80 : 0xffffff;
    this.sprite.width = PLAYER_SPRITE_SIZE * this.scaleK;
    this.sprite.height = PLAYER_SPRITE_SIZE * this.scaleK;
    // The boss sprite carries its own pack.
    if (r === "boss") this.backpack.visible = false;
    this.bpLevel = -1;
    // Bigger body: the hands sit further forward, so does the gun.
    const id = this.weaponId;
    this.weaponId = "";
    this.setWeapon(id);

    const kind = r === "boss" || r === "guard" ? kindOfNpc({ nickname, x, y }, bosses ?? []) : null;
    this.name.text = npcNameTag(r, kind, nickname);
    this.name.style.fontSize = r === "boss" ? 16 : 13;
    this.name.style.letterSpacing = r === "boss" ? 2 : 0;
    const head = -PLAYER.RADIUS * (r === "boss" ? 1.35 : 1);
    const badged = r === "guard" || r === "marauder";
    this.name.position.set(badged ? 8 : 0, head - 16);
    this.badge.visible = badged;
    if (badged) {
      this.badge.context = r === "guard" ? guardBadgeContext() : npcBadgeContext();
      this.badge.position.set(8 - this.name.width / 2 - 9, head - 16 - this.name.height / 2 + 1);
    }
    this.colorKey = "";
    this.barsKey = "";
    this.statusY = head - 44;
    this.status.position.set(0, this.statusY);
  }

  /** NPC role of this view (null = a human player). */
  get npc(): NpcRole {
    return this.role;
  }

  setWeapon(weapon: string) {
    if (weapon === this.weaponId) return;
    this.weaponId = weapon;
    if (!isWeaponId(weapon)) {
      this.weapon.visible = false;
      return;
    }
    this.weapon.visible = true;
    this.weapon.texture = this.tex[weapon];
    const len = WEAPON_HELD_LENGTH[weapon];
    fitWidth(this.weapon, len);
    this.weapon.position.set(WEAPONS[weapon].muzzle - len + (this.scaleK - 1) * PLAYER_SPRITE_SIZE * 0.4, 0);
  }

  /** Backpack level 0..3 (Player.bp); the icon loads lazily, so this retries until it has one. */
  setBackpack(level: number) {
    if (this.role === "boss") return;
    const lvl = Math.max(0, Math.min(3, Math.floor(level)));
    if (lvl === this.bpLevel && (lvl === 0 || this.backpack.texture !== Texture.EMPTY)) return;
    if (lvl === 0) {
      this.bpLevel = 0;
      this.backpack.visible = false;
      return;
    }
    const t = this.icons.get(`backpack_${lvl}`);
    if (!t || t === Texture.EMPTY) {
      this.backpack.visible = false;
      return;
    }
    this.bpLevel = lvl;
    this.backpack.texture = t;
    const w = BACKPACK_W[lvl as 1 | 2 | 3];
    // Rotated 90°: the icon's width runs along the body's y axis.
    this.backpack.width = w;
    this.backpack.height = (w * (t.height || 1)) / (t.width || 1);
    this.backpack.position.set(-PLAYER.RADIUS * 0.55 - w * 0.25, 0);
    this.backpack.visible = true;
  }

  /** HP (against maxHp: bosses and guards have more than PLAYER.MAX_HP) and armor bars. */
  setBars(hp: number, armor: number, armorDur: number, armorMax: number, maxHp: number = PLAYER.MAX_HP) {
    const key = `${Math.ceil(hp)}|${armor}|${Math.ceil(armorDur)}|${maxHp}|${this.role ?? ""}`;
    if (key === this.barsKey) return;
    this.barsKey = key;
    const boss = this.role === "boss";
    const W = boss ? 84 : this.role === "guard" ? 52 : this.role === "marauder" ? 48 : 44;
    const H = boss ? 7 : 5;
    const y = -PLAYER.RADIUS * (boss ? 1.35 : 1) - 13;
    const g = this.bars;
    g.clear();
    g.roundRect(-W / 2 - 2, y - 2, W + 4, H + 4, 3).fill({ color: 0x111111, alpha: 0.85 });
    const k = hpFraction(hp, maxHp);
    const hpColor = boss ? BOSS_COLOR : k > 0.6 ? 0x5ee35a : k > 0.3 ? 0xffc533 : 0xff4b4b;
    if (k > 0) g.roundRect(-W / 2, y, W * k, H, 2).fill({ color: hpColor });
    if (armor > 0 && armorMax > 0) {
      const a = Math.max(0, Math.min(1, armorDur / armorMax));
      g.rect(-W / 2, y + H, W * a, 2).fill({ color: COLORS.hitArmor });
    }
  }

  /** Labels are hidden for the local player and for players hiding in a bush. */
  setLabelVisible(v: boolean) {
    this.label.visible = v && !this.isSelf;
  }

  private setStatus(kind: "" | "heal" | "loot") {
    if (kind === this.statusKind) return;
    this.statusKind = kind;
    if (!kind) {
      this.status.visible = false;
      return;
    }
    this.status.context = statusContexts()[kind];
    this.status.visible = true;
  }

  /**
   * ACT flags of this frame (remote: Player.act; self: derived from the predicted roll and own
   * timers). The roll start is remembered when the flag first appears so the spin plays once.
   */
  setAct(act: number, nowMs: number) {
    if (act & ACT.ROLL && !(this.act & ACT.ROLL)) this.rollStartedAt = nowMs;
    this.act = act;
    this.setStatus(act & ACT.HEAL ? "heal" : act & ACT.LOOT ? "loot" : "");
    this.extractRing.visible = (act & ACT.EXTRACT) !== 0;
    if (this.status.visible) {
      this.status.y = this.statusY + Math.sin(nowMs / 160) * 2;
    }
    if (this.extractRing.visible) {
      const p = (nowMs % 1200) / 1200;
      this.extractRing.scale.set(0.9 + 0.25 * p);
      this.extractRing.alpha = 1 - p;
    }
  }

  place(x: number, y: number, aim: number, nowMs = 0) {
    this.x = x;
    this.y = y;
    this.root.position.set(x, y);
    let rot = aim;
    let squash = 1;
    const sinceRoll = nowMs - this.rollStartedAt;
    if (this.act & ACT.ROLL || sinceRoll < ROLL_ANIM_MS) {
      rot += rollSpin(sinceRoll);
      squash = 0.88;
    }
    this.body.rotation = rot;
    this.body.scale.set(squash);
    // Reload: the gun dips and swings toward the body while the mag is changed.
    if (this.act & ACT.RELOAD) {
      this.weapon.rotation = -0.65 + Math.sin(nowMs / 140) * 0.08;
    } else if (this.weapon.rotation !== 0) {
      this.weapon.rotation = 0;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

/* ---------------------------------------------------------------------------- ground items */

const GROUND_ICON_W: Record<string, number> = { armor: 32, backpack: 34, ammo: 26, med: 26, junk: 28 };

export class ItemView {
  readonly root = new Container();
  private readonly glow = new Graphics();
  private readonly icon: Sprite;
  private readonly phase = Math.random() * Math.PI * 2;
  private key = "";
  private loaded = false;
  /** Fog alpha (0..1), eased by the renderer. */
  alpha = 0;

  constructor(
    private readonly tex: Textures,
    private readonly icons: IconCache,
  ) {
    this.icon = new Sprite(Texture.EMPTY);
    this.icon.anchor.set(0.5);
    this.root.addChild(this.glow, this.icon);
  }

  /** Rebuild only when what the item is changes (state reuses the instance for qty updates). */
  sync(item: { def: string; rarity: number }) {
    const key = `${item.def}|${item.rarity}`;
    if (key === this.key && this.loaded) return;
    if (key !== this.key) {
      this.key = key;
      this.loaded = false;
      const d = itemDef(item.def);
      const rarity = d?.cat === "weapon" ? item.rarity : (d?.rarity ?? 0);
      const color = RARITY_COLORS[rarity as 0 | 1 | 2 | 3] ?? RARITY_COLORS[0];
      const R = d?.cat === "weapon" ? 26 : 19;
      this.glow.clear();
      this.glow.circle(0, 0, R).fill({ color, alpha: 0.2 });
      this.glow.circle(0, 0, R).stroke({ width: 2.5, color, alpha: 0.85 });
    }
    const d = itemDef(item.def);
    const t = d ? iconTexture(this.tex, this.icons, d.icon) : null;
    if (!t) return;
    this.loaded = true;
    this.icon.texture = t;
    this.icon.tint = d?.ammo ? (AMMO_TINT[d.ammo] ?? 0xffffff) : 0xffffff;
    if (d?.weapon) {
      fitWidth(this.icon, WEAPON_GROUND_LENGTH[d.weapon]);
      this.icon.rotation = -0.35;
    } else {
      fitWidth(this.icon, GROUND_ICON_W[d?.cat ?? "junk"] ?? 26);
      this.icon.rotation = 0;
    }
  }

  update(x: number, y: number, nowMs: number) {
    this.root.position.set(x, y);
    this.icon.y = Math.sin(nowMs / 450 + this.phase) * 2.5;
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

/* ---------------------------------------------------------------------------- corpses */

export class CorpseView {
  readonly root = new Container();
  private readonly ring = new Graphics();
  private readonly sprite = new Sprite(Texture.EMPTY);
  private readonly name: Text;
  private colorKey = "";
  private stateKey = "";
  private labelKey = "";
  /** Fog alpha (0..1), eased by the renderer. */
  alpha = 0;

  constructor(private readonly icons: IconCache) {
    this.sprite.anchor.set(0.5);
    this.name = new Text({
      text: "",
      style: { fontFamily: LABEL_FONT, fontSize: 11, fontWeight: "700", fill: 0xd0d0d0, stroke: { color: 0x111111, width: 3 } },
      resolution: 2,
    });
    this.name.anchor.set(0.5, 0);
    this.name.position.set(0, 30);
    this.root.addChild(this.ring, this.sprite, this.name);
  }

  /**
   * `npc` (NPC MODEL v5): the body of an NPC — khaki-olive ground ring and tint instead of a player
   * colour, and its role name ("Marauder") as the label; `npcName` is that display name.
   */
  sync(
    c: { x: number; y: number; label: string; color: number; rot: number; opened: boolean; empty: boolean },
    npc: NpcRoleName | null = null,
    npcName = "",
  ) {
    this.root.position.set(c.x, c.y);
    if (this.sprite.texture === Texture.EMPTY) {
      const t = this.icons.get("corpse");
      if (t && t !== Texture.EMPTY) {
        this.sprite.texture = t;
        fitWidth(this.sprite, 64);
      }
    }
    // The sprite's head points up (−y): turn it to face the death aim.
    this.sprite.rotation = c.rot + Math.PI / 2;
    const colorKey = npc ? `npc:${npc}` : String(c.color);
    if (colorKey !== this.colorKey) {
      this.colorKey = colorKey;
      this.ring.clear();
      if (npc) {
        // Dashed-looking double ring in the role colour: an NPC body, not a raider's.
        this.ring.ellipse(0, 0, 34, 26).fill({ color: NPC_CORPSE_TINT, alpha: 0.2 });
        this.ring.ellipse(0, 0, 34, 26).stroke({ width: 2, color: NPC_RING_COLOR[npc], alpha: 0.55 });
      } else {
        this.ring.ellipse(0, 0, 34, 26).fill({ color: playerColor(c.color), alpha: 0.18 });
      }
    }
    const label = npc ? npcName || c.label : c.label;
    const labelKey = `${npc ?? ""}|${label}`;
    if (labelKey !== this.labelKey) {
      this.labelKey = labelKey;
      this.name.text = label;
      this.name.style.fill = npc ? NPC_TAG_COLOR[npc] : 0xd0d0d0;
    }
    const key = `${c.opened}|${c.empty}|${npc ?? ""}`;
    if (key !== this.stateKey) {
      this.stateKey = key;
      // Searched bodies read "done" at a glance; emptied ones fade into the ground. NPC bodies keep
      // their olive tint so they never pass for a raider's.
      const base = npc ? NPC_CORPSE_TINT : 0xffffff;
      this.sprite.tint = c.empty ? 0x5a5a5a : c.opened ? (npc ? 0x7d7a64 : 0xb0b0b0) : base;
      this.name.alpha = c.empty ? 0.45 : 0.85;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

/* ---------------------------------------------------------------------------- containers */

/** Static container look by MapData tier (0 = small cache .. 4 = legendary). */
export function containerSprite(tier: number): { sprite: SpriteName; size: number; color: number } {
  const t = Math.max(0, Math.min(4, Math.floor(tier)));
  if (t === 0) return { sprite: "crate", size: 44, color: RARITY_COLORS[0] };
  const r = (t - 1) as 0 | 1 | 2 | 3;
  const sprites = ["chest_common", "chest_rare", "chest_epic", "chest_legendary"] as const;
  return { sprite: sprites[r], size: CHEST_SIZE[r], color: RARITY_COLORS[r] };
}

interface ContainerMarker {
  root: Container;
  glow: Graphics;
  sprite: Sprite;
  state: number;
  phase: number;
}

/**
 * Markers for MapData.containers (~400 on Steppe), coloured by tier and dimmed by
 * BattleState.containerState. They are part of the static map (memory under the fog, never
 * faded). Views are created lazily per 1024 px chunk the first time it comes into view, and whole
 * chunks are toggled, so the per-frame cost is the handful of visible chunks only.
 */
export class ContainerLayer {
  readonly root = new Container();
  private readonly chunks = new Map<number, { root: Container; markers: Array<[number, ContainerMarker]> }>();
  private readonly byChunk = new Map<number, number[]>();
  private readonly cols: number;
  private visible: number[] = [];
  private readonly scratch: number[] = [];

  constructor(
    private readonly containers: readonly ContainerSpot[],
    private readonly tex: Textures,
    mapWidth: number,
  ) {
    this.cols = Math.max(1, Math.ceil(mapWidth / WORLD.CHUNK));
    containers.forEach((c, i) => {
      const k = this.chunkKey(c.x, c.y);
      let l = this.byChunk.get(k);
      if (!l) this.byChunk.set(k, (l = []));
      l.push(i);
    });
  }

  private chunkKey(x: number, y: number): number {
    return Math.floor(y / WORLD.CHUNK) * this.cols + Math.floor(x / WORLD.CHUNK);
  }

  private build(key: number) {
    const root = new Container();
    const markers: Array<[number, ContainerMarker]> = [];
    for (const i of this.byChunk.get(key) ?? []) {
      const c = this.containers[i]!;
      const look = containerSprite(c.tier);
      const sprite = new Sprite(this.tex[look.sprite]);
      sprite.anchor.set(0.5);
      fitWidth(sprite, look.size);
      const glow = new Graphics();
      const gr = look.size * 0.62;
      glow.circle(0, 0, gr).fill({ color: look.color, alpha: 0.22 });
      glow.circle(0, 0, gr).stroke({ width: 3, color: look.color, alpha: 0.7 });
      const m: ContainerMarker = { root: new Container(), glow, sprite, state: -1, phase: (i * 2.399) % (Math.PI * 2) };
      m.root.position.set(c.x, c.y);
      m.root.addChild(glow, sprite);
      root.addChild(m.root);
      markers.push([i, m]);
    }
    const chunk = { root, markers };
    this.chunks.set(key, chunk);
    this.root.addChild(root);
    return chunk;
  }

  /** Show the chunks overlapping the view rect and animate their markers. */
  update(x0: number, y0: number, x1: number, y1: number, containerState: ArrayLike<number>, nowMs: number) {
    const C = WORLD.CHUNK;
    const want = this.scratch;
    want.length = 0;
    const cx0 = Math.max(0, Math.floor(x0 / C)), cx1 = Math.min(this.cols - 1, Math.floor(x1 / C));
    const cy0 = Math.max(0, Math.floor(y0 / C)), cy1 = Math.floor(y1 / C);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const k = cy * this.cols + cx;
      if (this.byChunk.has(k)) want.push(k);
    }
    for (const k of this.visible) if (!want.includes(k)) this.chunks.get(k)!.root.visible = false;
    for (const k of want) {
      const chunk = this.chunks.get(k) ?? this.build(k);
      chunk.root.visible = true;
      for (const [i, m] of chunk.markers) {
        const st = containerState[i] ?? CONTAINER_STATE.UNTOUCHED;
        if (st !== m.state) {
          m.state = st;
          m.glow.visible = st === CONTAINER_STATE.UNTOUCHED;
          m.sprite.tint = st === CONTAINER_STATE.EMPTIED ? 0x585858 : st === CONTAINER_STATE.OPENED ? 0x9a9a9a : 0xffffff;
          m.sprite.alpha = st === CONTAINER_STATE.EMPTIED ? 0.8 : 1;
        }
        if (st === CONTAINER_STATE.UNTOUCHED) {
          const p = 0.5 + 0.5 * Math.sin(nowMs / 400 + m.phase);
          m.glow.alpha = 0.55 + 0.45 * p;
          m.glow.scale.set(0.95 + 0.08 * p);
        }
      }
    }
    this.visible = want.slice();
  }

  /** World position of container i (chest events). */
  at(i: number): ContainerSpot | undefined {
    return this.containers[i];
  }

  destroy() {
    this.root.destroy({ children: true });
    this.chunks.clear();
  }
}

/* ---------------------------------------------------------------------------- damage arcs */

export const DAMAGE_ARC = {
  /** Screen px from the player centre to the arc. */
  RADIUS: 92,
  /** Arc width (radians) and life. */
  SPAN: (70 * Math.PI) / 180,
  LIFE_MS: 1100,
  MAX: 8,
} as const;

/** Arc alpha over its life: instant in, linger, fade out; damage scales the peak. */
export function damageArcAlpha(ageMs: number, damage: number): number {
  if (ageMs < 0 || ageMs >= DAMAGE_ARC.LIFE_MS) return 0;
  const peak = Math.min(1, 0.45 + damage / 40);
  const fadeFrom = DAMAGE_ARC.LIFE_MS * 0.45;
  return ageMs <= fadeFrom ? peak : peak * (1 - (ageMs - fadeFrom) / (DAMAGE_ARC.LIFE_MS - fadeFrom));
}

/**
 * Red arcs around the local player pointing at whoever hit them (HitMsg.fa, the target's copy
 * only, quantised to 2π/64 by the server). A plug-in system drawing into the screen layer: one
 * shared arc geometry, pooled Graphics, no per-frame tessellation.
 */
export class DamageArcSystem implements GameSystem {
  readonly id = "damage-arc";
  private root: Container | null = null;
  private ctx: GraphicsContext | null = null;
  private arcs: Array<{ g: Graphics; angle: number; born: number; dmg: number }> = [];
  private pool: Graphics[] = [];

  init(c: GameContext) {
    this.root = new Container();
    this.root.label = "damage-arcs";
    c.layers.screen.addChild(this.root);
    const R = DAMAGE_ARC.RADIUS, h = DAMAGE_ARC.SPAN / 2;
    // Pointing along +x; each arc is a rotated Graphics sharing this context.
    this.ctx = new GraphicsContext()
      .arc(0, 0, R, -h, h)
      .stroke({ width: 10, color: 0xff2d2d, alpha: 0.35, cap: "round" })
      .arc(0, 0, R, -h * 0.7, h * 0.7)
      .stroke({ width: 5, color: 0xff5a4a, alpha: 0.95, cap: "round" });
  }

  onEvents(ev: EventsMsg, c: GameContext) {
    if (!ev.hits || !this.root || !this.ctx) return;
    const me = c.room.sessionId;
    const now = performance.now();
    for (const h of ev.hits) {
      if (h.t !== me || typeof h.fa !== "number" || !(h.d > 0)) continue;
      const g = this.pool.pop() ?? new Graphics(this.ctx);
      if (!g.parent) this.root.addChild(g);
      g.visible = true;
      g.rotation = h.fa;
      this.arcs.push({ g, angle: h.fa, born: now, dmg: h.d });
      if (this.arcs.length > DAMAGE_ARC.MAX) this.release(this.arcs.shift()!);
    }
  }

  frame(_dt: number, c: GameContext) {
    if (!this.root || this.arcs.length === 0) return;
    const now = performance.now();
    const p = c.selfPos();
    const s = c.toScreen(p.x, p.y);
    this.root.position.set(s.x, s.y);
    let w = 0;
    for (const a of this.arcs) {
      const alpha = damageArcAlpha(now - a.born, a.dmg);
      if (alpha <= 0) {
        this.release(a);
        continue;
      }
      a.g.alpha = alpha;
      this.arcs[w++] = a;
    }
    this.arcs.length = w;
  }

  private release(a: { g: Graphics }) {
    a.g.visible = false;
    this.pool.push(a.g);
  }

  dispose() {
    this.root?.destroy({ children: true });
    this.root = null;
    this.ctx?.destroy();
    this.ctx = null;
    this.arcs = [];
    this.pool = [];
  }
}

export type ExtractStatus = "waiting" | "open" | "closed";

export class ExtractView {
  readonly root = new Container();
  /**
   * Static shapes, redrawn only when status / radius / progress change (WP-H: clearing and
   * re-tessellating ~30 primitives per extract every frame was pure waste). The open-state
   * pulse is animated with `alpha` / `scale` on these instead.
   */
  private readonly fill = new Graphics();
  private readonly ring = new Graphics();
  private readonly pulse = new Graphics();
  private readonly progressG = new Graphics();
  private readonly caption: Text;
  private captionText = "";
  private shapeKey = "";
  /** Progress in whole percent as drawn, -1 = no progress ring. */
  private progressPct = -1;
  private progressR = -1;

  constructor() {
    this.caption = new Text({
      text: "",
      style: {
        fontFamily: LABEL_FONT,
        fontSize: 15,
        fontWeight: "800",
        fill: 0xffffff,
        stroke: { color: 0x111111, width: 4 },
        letterSpacing: 1,
      },
      resolution: 2,
    });
    this.caption.anchor.set(0.5);
    this.root.addChild(this.fill, this.ring, this.pulse, this.progressG, this.caption);
  }

  /**
   * @param progress 0..1 extraction channel progress of the local player in this circle, or null.
   */
  update(x: number, y: number, r: number, status: ExtractStatus, caption: string, progress: number | null, nowMs: number) {
    this.root.position.set(x, y);
    const key = `${status}|${r}`;
    if (key !== this.shapeKey) {
      this.shapeKey = key;
      this.drawShapes(r, status);
    }
    if (status === "open") {
      const p = 0.5 + 0.5 * Math.sin(nowMs / 300);
      this.fill.alpha = 0.14 + 0.1 * p;
      this.ring.alpha = 0.75 + 0.25 * p;
      const phase = (nowMs / 1400) % 1;
      this.pulse.scale.set(0.55 + 0.4 * phase);
      this.pulse.alpha = 0.5 * (1 - phase);
    }

    const pct = progress === null ? -1 : Math.round(Math.max(0, Math.min(1, progress)) * 100);
    if (pct !== this.progressPct || r !== this.progressR) {
      this.progressPct = pct;
      this.progressR = r;
      const g = this.progressG;
      g.clear();
      if (pct >= 0) {
        g.circle(0, 0, r + 12).stroke({ width: 8, color: 0x000000, alpha: 0.35 });
        if (pct > 0) {
          g.moveTo(0, -(r + 12))
            .arc(0, 0, r + 12, -Math.PI / 2, -Math.PI / 2 + (pct / 100) * Math.PI * 2)
            .stroke({ width: 8, color: 0xffffff, alpha: 0.95, cap: "round" });
        }
      }
    }
    if (caption !== this.captionText) {
      this.captionText = caption;
      this.caption.text = caption;
    }
    // Above the ring (and the progress arc) so it never sits on top of the player in the middle.
    this.caption.y = -(r + 30);
  }

  private drawShapes(r: number, status: ExtractStatus) {
    const { fill, ring, pulse } = this;
    fill.clear();
    ring.clear();
    pulse.clear();
    if (status === "open") {
      // Drawn at full alpha; update() modulates the Graphics' alpha for the pulse.
      fill.circle(0, 0, r).fill({ color: COLORS.extractOpen });
      ring.circle(0, 0, r).stroke({ width: 6, color: COLORS.extractOpen });
      // The expanding ring is scaled 0.55..0.95 per frame; width 4 scales to ~2.2..3.8 (was 3).
      pulse.circle(0, 0, r).stroke({ width: 4, color: COLORS.extractOpen });
      pulse.visible = true;
    } else {
      const c = status === "waiting" ? COLORS.extractWaiting : COLORS.extractClosed;
      fill.circle(0, 0, r).fill({ color: c });
      fill.alpha = status === "waiting" ? 0.1 : 0.16;
      // Dashed ring: reads as "not active" at a glance.
      const dashes = 24;
      for (let i = 0; i < dashes; i++) {
        const a0 = (i / dashes) * Math.PI * 2;
        const a1 = a0 + (Math.PI * 2) / dashes / 2;
        ring.moveTo(Math.cos(a0) * r, Math.sin(a0) * r).arc(0, 0, r, a0, a1);
      }
      ring.stroke({ width: 5, color: c });
      ring.alpha = 0.85;
      pulse.visible = false;
    }
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}
