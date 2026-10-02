/**
 * Display objects for state entities (players, chests, ground items, extraction points).
 * Views only draw; positions/visibility are decided by the renderer each frame.
 */

import { Container, Graphics, Sprite, Text } from "pixi.js";
import {
  PLAYER,
  RARITY_COLORS,
  WEAPONS,
  type Chest,
  type GroundItem,
  type WeaponId,
} from "@extract/shared";
import {
  AMMO_TINT,
  CHEST_SIZE,
  CHEST_SPRITES,
  COLORS,
  PLAYER_SPRITE_SIZE,
  WEAPON_GROUND_LENGTH,
  WEAPON_HELD_LENGTH,
  playerColor,
  type Textures,
} from "./assets";
import { SnapshotBuffer } from "./prediction";

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

export class PlayerView {
  readonly root = new Container();
  /** Rotates with aim: weapon + body. */
  private readonly body = new Container();
  private readonly ring = new Graphics();
  private readonly weapon: Sprite;
  private readonly sprite: Sprite;
  private readonly label = new Container();
  private readonly name: Text;
  private readonly bars = new Graphics();
  readonly buffer = new SnapshotBuffer();

  private weaponId = "";
  private barsKey = "";
  private colorIndex = -1;

  /** Last rendered position (used for effects anchoring, e.g. death bursts). */
  x = 0;
  y = 0;

  constructor(
    private readonly tex: Textures,
    readonly sessionId: string,
    readonly isSelf: boolean,
    nickname: string,
  ) {
    this.weapon = new Sprite(tex.pistol);
    this.weapon.anchor.set(0, 0.5);
    this.sprite = new Sprite(tex.player);
    this.sprite.anchor.set(0.5);
    this.sprite.width = PLAYER_SPRITE_SIZE;
    this.sprite.height = PLAYER_SPRITE_SIZE;
    // The gun goes under the body so the arms/hands sit on top of its grip.
    this.body.addChild(this.weapon, this.sprite);

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
    this.label.addChild(this.name, this.bars);
    this.label.visible = !isSelf;

    this.root.addChild(this.ring, this.body, this.label);
  }

  setColor(index: number) {
    if (index === this.colorIndex) return;
    this.colorIndex = index;
    const c = playerColor(index);
    this.ring.clear();
    this.ring.circle(0, 0, PLAYER.RADIUS + 3).fill({ color: c, alpha: 0.28 });
    this.ring.circle(0, 0, PLAYER.RADIUS + 3).stroke({ width: 4, color: c, alpha: 0.95 });
    this.name.style.fill = this.isSelf ? 0xffffff : c;
  }

  setNickname(nick: string) {
    if (this.name.text !== nick) this.name.text = nick;
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
    this.weapon.position.set(WEAPONS[weapon].muzzle - len, 0);
  }

  setBars(hp: number, armor: number, armorDur: number, armorMax: number) {
    const key = `${Math.ceil(hp)}|${armor}|${Math.ceil(armorDur)}`;
    if (key === this.barsKey) return;
    this.barsKey = key;
    const W = 44;
    const y = -PLAYER.RADIUS - 13;
    const g = this.bars;
    g.clear();
    g.roundRect(-W / 2 - 2, y - 2, W + 4, 9, 3).fill({ color: 0x111111, alpha: 0.85 });
    const k = Math.max(0, Math.min(1, hp / PLAYER.MAX_HP));
    const hpColor = k > 0.6 ? 0x5ee35a : k > 0.3 ? 0xffc533 : 0xff4b4b;
    if (k > 0) g.roundRect(-W / 2, y, W * k, 5, 2).fill({ color: hpColor });
    if (armor > 0 && armorMax > 0) {
      const a = Math.max(0, Math.min(1, armorDur / armorMax));
      g.rect(-W / 2, y + 5, W * a, 2).fill({ color: COLORS.hitArmor });
    }
  }

  /** Labels are hidden for the local player and for players hiding in a bush. */
  setLabelVisible(v: boolean) {
    this.label.visible = v && !this.isSelf;
  }

  place(x: number, y: number, aim: number) {
    this.x = x;
    this.y = y;
    this.root.position.set(x, y);
    this.body.rotation = aim;
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

export class ChestView {
  readonly root = new Container();
  private readonly glow = new Graphics();
  private readonly sprite: Sprite;
  private opened: boolean | null = null;
  private readonly phase = Math.random() * Math.PI * 2;

  constructor(
    tex: Textures,
    readonly rarity: number,
  ) {
    const r = Math.max(0, Math.min(3, rarity)) as 0 | 1 | 2 | 3;
    this.sprite = new Sprite(tex[CHEST_SPRITES[r]]);
    this.sprite.anchor.set(0.5);
    fitWidth(this.sprite, CHEST_SIZE[r]);
    const glowR = CHEST_SIZE[r] * 0.62;
    this.glow.circle(0, 0, glowR).fill({ color: RARITY_COLORS[r], alpha: 0.22 });
    this.glow.circle(0, 0, glowR).stroke({ width: 3, color: RARITY_COLORS[r], alpha: 0.7 });
    this.root.addChild(this.glow, this.sprite);
  }

  update(chest: Pick<Chest, "x" | "y" | "opened">, nowMs: number) {
    this.root.position.set(chest.x, chest.y);
    if (chest.opened !== this.opened) {
      this.opened = chest.opened;
      this.glow.visible = !chest.opened;
      this.sprite.tint = chest.opened ? 0x6a6a6a : 0xffffff;
      this.sprite.alpha = chest.opened ? 0.85 : 1;
    }
    if (!chest.opened) {
      const p = 0.5 + 0.5 * Math.sin(nowMs / 400 + this.phase);
      this.glow.alpha = 0.55 + 0.45 * p;
      this.glow.scale.set(0.95 + 0.08 * p);
    }
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

/** Glow color for an item: weapons by rarity, armor by level, consumables neutral. */
export function itemRarity(item: Pick<GroundItem, "kind" | "rarity" | "armor">): number {
  if (item.kind === "weapon") return item.rarity;
  if (item.kind === "armor") return Math.max(0, Math.min(3, item.armor - 1));
  return 0;
}

export class ItemView {
  readonly root = new Container();
  private readonly glow = new Graphics();
  private readonly icon = new Container();
  private readonly phase = Math.random() * Math.PI * 2;
  private key = "";

  constructor(private readonly tex: Textures) {
    this.root.addChild(this.glow, this.icon);
  }

  /** Rebuild only when what the item is changes (state reuses the instance for qty updates). */
  sync(item: GroundItem) {
    const key = `${item.kind}|${item.weapon}|${item.rarity}|${item.armor}|${item.ammoType}`;
    if (key === this.key) return;
    this.key = key;
    for (const c of this.icon.removeChildren()) c.destroy();

    const rarity = itemRarity(item);
    const color = RARITY_COLORS[rarity as 0 | 1 | 2 | 3] ?? RARITY_COLORS[0];
    const R = item.kind === "weapon" ? 26 : 19;
    this.glow.clear();
    this.glow.circle(0, 0, R).fill({ color, alpha: 0.2 });
    this.glow.circle(0, 0, R).stroke({ width: 2.5, color, alpha: 0.85 });

    let s: Sprite;
    switch (item.kind) {
      case "weapon": {
        const w = isWeaponId(item.weapon) ? item.weapon : "pistol";
        s = new Sprite(this.tex[w]);
        fitWidth(s, WEAPON_GROUND_LENGTH[w]);
        s.rotation = -0.35;
        break;
      }
      case "armor": {
        const lvl = Math.max(1, Math.min(3, item.armor)) as 1 | 2 | 3;
        s = new Sprite(this.tex[`armor_${lvl}`]);
        fitWidth(s, 32);
        break;
      }
      case "ammo":
        s = new Sprite(this.tex.ammo);
        s.tint = AMMO_TINT[item.ammoType] ?? 0xffffff;
        fitWidth(s, 26);
        break;
      case "medkit":
        s = new Sprite(this.tex.medkit);
        fitWidth(s, 28);
        break;
      default:
        s = new Sprite(this.tex.bandage);
        fitWidth(s, 22);
        break;
    }
    s.anchor.set(0.5);
    this.icon.addChild(s);
  }

  update(x: number, y: number, nowMs: number) {
    this.root.position.set(x, y);
    this.icon.y = Math.sin(nowMs / 450 + this.phase) * 2.5;
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}

export type ExtractStatus = "waiting" | "open" | "closed";

export class ExtractView {
  readonly root = new Container();
  private readonly g = new Graphics();
  private readonly caption: Text;
  private captionText = "";

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
    this.root.addChild(this.g, this.caption);
  }

  /**
   * @param progress 0..1 extraction channel progress of the local player in this circle, or null.
   */
  update(x: number, y: number, r: number, status: ExtractStatus, caption: string, progress: number | null, nowMs: number) {
    this.root.position.set(x, y);
    const g = this.g;
    g.clear();
    if (status === "open") {
      const p = 0.5 + 0.5 * Math.sin(nowMs / 300);
      g.circle(0, 0, r).fill({ color: COLORS.extractOpen, alpha: 0.14 + 0.1 * p });
      g.circle(0, 0, r).stroke({ width: 6, color: COLORS.extractOpen, alpha: 0.75 + 0.25 * p });
      g.circle(0, 0, r * (0.55 + 0.4 * ((nowMs / 1400) % 1))).stroke({
        width: 3,
        color: COLORS.extractOpen,
        alpha: 0.5 * (1 - ((nowMs / 1400) % 1)),
      });
    } else {
      const c = status === "waiting" ? COLORS.extractWaiting : COLORS.extractClosed;
      g.circle(0, 0, r).fill({ color: c, alpha: status === "waiting" ? 0.1 : 0.16 });
      // Dashed ring: reads as "not active" at a glance.
      const dashes = 24;
      for (let i = 0; i < dashes; i++) {
        const a0 = (i / dashes) * Math.PI * 2;
        const a1 = a0 + (Math.PI * 2) / dashes / 2;
        g.moveTo(Math.cos(a0) * r, Math.sin(a0) * r).arc(0, 0, r, a0, a1);
      }
      g.stroke({ width: 5, color: c, alpha: 0.85 });
    }
    if (progress !== null) {
      const k = Math.max(0, Math.min(1, progress));
      g.circle(0, 0, r + 12).stroke({ width: 8, color: 0x000000, alpha: 0.35 });
      if (k > 0) {
        g.moveTo(0, -(r + 12))
          .arc(0, 0, r + 12, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2)
          .stroke({ width: 8, color: 0xffffff, alpha: 0.95, cap: "round" });
      }
    }
    if (caption !== this.captionText) {
      this.captionText = caption;
      this.caption.text = caption;
    }
    // Above the ring (and the progress arc) so it never sits on top of the player in the middle.
    this.caption.y = -(r + 30);
  }

  destroy() {
    this.root.destroy({ children: true });
  }
}
