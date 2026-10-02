"""Cut a flat chroma background out of generated sprites (gpt-image-2 has no transparent mode).

    uv run --with pillow scripts/key-bg.py in.png out.png [--tol 90] [--size 256]

Flood-fills from the image border, so only background connected to the edges is removed and
same-colored pixels inside the sprite survive. Background color is sampled from the corners.
Edge pixels get partial alpha and the background tint is pulled out of them (despill).
The result is trimmed to the sprite and optionally fit into a square of --size pixels.
"""

import argparse
from collections import deque

from PIL import Image


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--tol", type=float, default=90, help="color distance treated as background")
    ap.add_argument("--soft", type=float, default=60, help="extra distance for semi-transparent edge")
    ap.add_argument("--core", type=float, default=45, help="distance of 'pure' background seeded anywhere")
    ap.add_argument("--size", type=int, default=0, help="fit into a size x size square (0 = keep)")
    a = ap.parse_args()

    img = Image.open(a.src).convert("RGBA")
    w, h = img.size
    px = img.load()

    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

    def dist(c) -> float:
        return ((c[0] - bg[0]) ** 2 + (c[1] - bg[1]) ** 2 + (c[2] - bg[2]) ** 2) ** 0.5

    limit = a.tol + a.soft
    seen = bytearray(w * h)
    queue = deque()
    for x in range(w):
        queue.extend([(x, 0), (x, h - 1)])
    for y in range(h):
        queue.extend([(0, y), (w - 1, y)])
    # Also seed from near-exact background pixels anywhere: catches enclosed holes
    # (trigger guards, handles) that the border fill cannot reach.
    for y in range(h):
        for x in range(w):
            if dist(px[x, y]) <= a.core:
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        c = px[x, y]
        d = dist(c)
        if d > limit:
            continue
        if d <= a.tol:
            px[x, y] = (0, 0, 0, 0)
        else:
            t = (d - a.tol) / a.soft  # 0 = background, 1 = sprite
            alpha = int(255 * t)
            # despill: remove the background share from the edge color
            rgb = tuple(
                max(0, min(255, int((c[k] - bg[k] * (1 - t)) / max(t, 1e-3)))) for k in range(3)
            )
            px[x, y] = (*rgb, alpha)
            continue  # stop at the soft edge, do not flood into the sprite
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                queue.append((nx, ny))

    box = img.getbbox()
    if box:
        img = img.crop(box)
    if a.size:
        img.thumbnail((a.size, a.size), Image.LANCZOS)
        canvas = Image.new("RGBA", (a.size, a.size), (0, 0, 0, 0))
        canvas.paste(img, ((a.size - img.width) // 2, (a.size - img.height) // 2))
        img = canvas
    img.save(a.dst)
    print(a.dst, img.size, "bg", bg)


if __name__ == "__main__":
    main()
