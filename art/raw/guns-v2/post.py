"""Weapons v2 art post-processing (docs/WEAPONS_V2.md, art/guns-v2.json). Run from the repo root
after art/raw/guns-v2/gen.mjs:

    uv run --with pillow art/raw/guns-v2/post.py

Writes into apps/web/public/sprites/:
  icon_<gun>.png       inventory icons for all eight guns: the world sprite rotated 30 degrees
                       (muzzle up-right), trimmed and fitted into a 128 px square
  explosion_sheet.png  8 frames x 128 px in one row, built from explosion.png and smoke.png
and the contact sheet docs/weapons-v2-art.png (guns in a player's hands at game scale x3, inventory
icons on rarity slots, grenade / ammo / bolt, the explosion frames).
"""

from PIL import Image, ImageDraw, ImageEnhance

SP = "apps/web/public/sprites"
GUNS = ["pistol", "rifle", "shotgun", "sniper", "smg", "lmg", "revolver", "crossbow"]
NEW = {"smg", "lmg", "revolver", "crossbow"}
# Held length and muzzle (px) per gun: existing ones from apps/web/src/game/assets.ts and items.ts,
# the new ones as proposed in docs/WEAPONS_V2.md.
HELD = {"pistol": 26, "rifle": 54, "shotgun": 52, "sniper": 66, "smg": 40, "lmg": 70, "revolver": 30, "crossbow": 52}
MUZZLE = {"pistol": 44, "rifle": 58, "shotgun": 56, "sniper": 66, "smg": 48, "lmg": 70, "revolver": 46, "crossbow": 52}
RARITY = [(0xB8, 0xC0, 0xC8), (0x3D, 0x8B, 0xFF), (0xA6, 0x4D, 0xFF), (0xFF, 0xC2, 0x1A)]
ICON = 128
FRAME = 128


def load(name: str) -> Image.Image:
    return Image.open(f"{SP}/{name}.png").convert("RGBA")


def trim(im: Image.Image) -> Image.Image:
    box = im.getbbox()
    return im.crop(box) if box else im


def fit(im: Image.Image, size: int, pad: int) -> Image.Image:
    im = trim(im)
    im.thumbnail((size - 2 * pad, size - 2 * pad), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
    return out


def make_icons() -> None:
    for g in GUNS:
        im = trim(load(g)).rotate(30, resample=Image.BICUBIC, expand=True)
        fit(im, ICON, 6).save(f"{SP}/icon_{g}.png", optimize=True)


def scaled(im: Image.Image, k: float, alpha: float = 1.0) -> Image.Image:
    w = max(1, round(im.width * k))
    h = max(1, round(im.height * k))
    im = im.resize((w, h), Image.LANCZOS)
    if alpha < 1:
        a = im.getchannel("A").point(lambda v: int(v * alpha))
        im.putalpha(a)
    return im


def centre(dst: Image.Image, im: Image.Image) -> None:
    layer = Image.new("RGBA", dst.size, (0, 0, 0, 0))
    layer.paste(im, ((dst.width - im.width) // 2, (dst.height - im.height) // 2), im)
    dst.alpha_composite(layer)


def make_explosion_sheet() -> None:
    boom = fit(load("explosion"), FRAME, 2)
    smoke = fit(load("smoke"), FRAME, 2)
    flash = ImageEnhance.Brightness(boom).enhance(1.6)
    # (blast scale, blast alpha, smoke scale, smoke alpha); the flash frame uses the brightened blast
    plan = [
        ("flash", 0.38, 1.0, 0, 0),
        ("flash", 0.62, 1.0, 0, 0),
        ("boom", 0.86, 1.0, 0, 0),
        ("boom", 1.0, 1.0, 0.7, 0.35),
        ("boom", 0.8, 0.6, 0.92, 0.8),
        ("boom", 0.45, 0.3, 1.0, 0.85),
        (None, 0, 0, 1.0, 0.6),
        (None, 0, 0, 1.0, 0.36),
    ]
    sheet = Image.new("RGBA", (FRAME * len(plan), FRAME), (0, 0, 0, 0))
    for i, (kind, bk, ba, sk, sa) in enumerate(plan):
        f = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
        if sk:
            centre(f, scaled(smoke, sk, sa))
        if kind:
            centre(f, scaled(flash if kind == "flash" else boom, bk, ba))
        sheet.paste(f, (i * FRAME, 0), f)
    sheet.save(f"{SP}/explosion_sheet.png", optimize=True)


def label(d: ImageDraw.ImageDraw, xy, text: str, fill=(255, 255, 255, 255)) -> None:
    x, y = xy
    d.text((x + 1, y + 1), text, fill=(0, 0, 0, 200))
    d.text((x, y), text, fill=fill)


def contact_sheet(out: str) -> None:
    K = 2.5  # game px -> sheet px
    W = 8 * 190 + 20
    sheet = Image.new("RGBA", (W, 1010), (96, 160, 60, 255))
    d = ImageDraw.Draw(sheet)
    label(d, (12, 8), "SPOILS - Weapons v2 art (docs/WEAPONS_V2.md). New: smg, lmg, revolver, crossbow, grenade, ammo icons, bolt, explosion.")

    # Row 1: guns in a player's hands, game scale x3 (player 60 px, weapon under the body like entities.ts)
    label(d, (12, 30), "In hands, game scale x2.5 (held length / muzzle as in assets.ts; new ones proposed)")
    player = load("player")
    pw = round(60 * K)
    for i, g in enumerate(GUNS):
        cell = Image.new("RGBA", (190, 230), (0, 0, 0, 0))
        cx, cy = 75, 115
        gun = trim(load(g))
        L = round(HELD[g] * K)
        gun = gun.resize((L, max(1, round(gun.height * L / gun.width))), Image.LANCZOS)
        gx = round(cx + (MUZZLE[g] - HELD[g]) * K)
        cell.alpha_composite(gun, (gx, cy - gun.height // 2))
        p = player.resize((pw, pw), Image.LANCZOS)
        cell.alpha_composite(p, (cx - pw // 2, cy - pw // 2))
        sheet.alpha_composite(cell, (10 + i * 190, 48))
        label(d, (20 + i * 190, 262), g + (" (new)" if g in NEW else ""), (255, 255, 160, 255) if g in NEW else (255, 255, 255, 255))

    # Row 2: world sprites as files (lying on the ground) and inventory icons on rarity slots
    label(d, (12, 290), "World sprites (files, pointing right) and inventory icons icon_<gun>.png on the four rarity slot colours")
    for i, g in enumerate(GUNS):
        x = 10 + i * 190
        w = fit(load(g), 170, 4)
        sheet.alpha_composite(w, (x + 10, 300))
        for r in range(4):
            sx, sy = x + 6 + (r % 2) * 90, 480 + (r // 2) * 90
            slot = Image.new("RGBA", (84, 84), (*RARITY[r], 90))
            ImageDraw.Draw(slot).rectangle([0, 0, 83, 83], outline=(*RARITY[r], 255), width=3)
            sheet.alpha_composite(slot, (sx, sy))
            ic = load(f"icon_{g}").resize((76, 76), Image.LANCZOS)
            sheet.alpha_composite(ic, (sx + 4, sy + 4))

    # Row 3: grenade, ammo, bolt
    label(d, (12, 670), "Grenade, ammo icons (light / shell / heavy / bolt, new), crossbow bolt projectile (x2), in-raid size x3 of the grenade")
    items = ["grenade", "ammo_light", "ammo_shell", "ammo_heavy", "ammo_bolt", "bolt"]
    for i, n in enumerate(items):
        x = 10 + i * 190
        ic = fit(load(n), 150, 4)
        sheet.alpha_composite(ic, (x + 20, 688))
        label(d, (x + 30, 842), n)
    g3 = trim(load("grenade"))
    g3.thumbnail((42, 42), Image.LANCZOS)
    sheet.alpha_composite(g3, (10 + 6 * 190 + 40, 740))
    label(d, (10 + 6 * 190 + 20, 842), "grenade 14 px x3")

    # Row 4: explosion sheet
    label(d, (12, 866), "explosion_sheet.png: 8 frames x 128 px (flash, blast, blast to smoke, smoke fading)")
    ex = load("explosion_sheet")
    ex = ex.resize((ex.width * 120 // 128, 120), Image.LANCZOS)
    sheet.alpha_composite(ex, (12, 884))
    sheet.convert("RGB").save(out, optimize=True)
    print(out, sheet.size)


if __name__ == "__main__":
    make_icons()
    make_explosion_sheet()
    contact_sheet("docs/weapons-v2-art.png")
