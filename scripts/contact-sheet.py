"""Lay all sprites from art/sprites/ on a grass background with labels, for a quick visual review.

    uv run --with pillow scripts/contact-sheet.py [out.png]
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

CELL, COLS, PAD = 200, 6, 10
files = sorted(Path("art/sprites").glob("*.png"))
rows = (len(files) + COLS - 1) // COLS
sheet = Image.new("RGBA", (COLS * CELL, rows * (CELL + 24)), (96, 160, 60, 255))
draw = ImageDraw.Draw(sheet)

for i, f in enumerate(files):
    img = Image.open(f).convert("RGBA")
    img.thumbnail((CELL - 2 * PAD, CELL - 2 * PAD), Image.LANCZOS)
    x, y = (i % COLS) * CELL, (i // COLS) * (CELL + 24)
    sheet.paste(img, (x + (CELL - img.width) // 2, y + (CELL - img.height) // 2), img)
    draw.text((x + 8, y + CELL + 4), f.stem, fill=(255, 255, 255, 255))

out = sys.argv[1] if len(sys.argv) > 1 else "art/contact-sheet.png"
sheet.save(out)
print(out, sheet.size, len(files), "sprites")
