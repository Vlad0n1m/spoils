# Map v2 tile tools (art/map-v2.json "post" steps). Run with: uv run --with pillow --with numpy scripts/tile-seamless.py ...
#   crop RAW OUT SIZE X0 Y0 X1 Y1   exact period box of a grid tile ("crop ..." in the manifest)
#   check RAW...  |  grid IMG OUT  |  trim  |  fix (alpha blend; not used for the shipped tiles)
# "seamcut F" tiles use scripts/tile-quilt.py RAW OUT SIZE F.
"""Seam check and seamless fix for generated ground tiles.

  tile.py check RAW...            print wrap-seam error vs interior neighbour error
  tile.py fix RAW OUT SIZE [BAND] blend each axis with its half-rolled copy in edge bands, resize
  tile.py grid IMG OUT            2x2 tiled preview
"""
import sys
import numpy as np
from PIL import Image

def load(p): return np.asarray(Image.open(p).convert("RGB"), dtype=np.float32)

def seam(a):
    inner_x = np.abs(np.diff(a, axis=1)).mean()
    inner_y = np.abs(np.diff(a, axis=0)).mean()
    wrap_x = np.abs(a[:, 0] - a[:, -1]).mean()
    wrap_y = np.abs(a[0] - a[-1]).mean()
    return wrap_x / inner_x, wrap_y / inner_y

def blend_axis(a, axis, band):
    n = a.shape[axis]
    b = np.roll(a, n // 2, axis=axis)
    t = np.arange(n, dtype=np.float32)
    d = np.minimum(t, n - 1 - t) / (band * n)       # 0 at the edges, 1 at the band's inner end
    w = np.clip(d, 0, 1); w = w * w * (3 - 2 * w)    # smoothstep: 0 → rolled copy, 1 → original
    shape = [1, 1, 1]; shape[axis] = n
    w = w.reshape(shape)
    return a * w + b * (1 - w)

cmd = sys.argv[1]
if cmd == "check":
    for p in sys.argv[2:]:
        sx, sy = seam(load(p)); print(f"{p.split('/')[-1]:28s} seam x {sx:5.2f}  y {sy:5.2f}")
elif cmd == "fix":
    src, out, size = sys.argv[2], sys.argv[3], int(sys.argv[4])
    band = float(sys.argv[5]) if len(sys.argv) > 5 else 0.22
    a = load(src)
    a = blend_axis(blend_axis(a, 1, band), 0, band)
    sx, sy = seam(a)
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).resize((size, size), Image.LANCZOS).save(out)
    print(out, f"seam after x {sx:.2f} y {sy:.2f}")
elif cmd == "grid":
    im = Image.open(sys.argv[2]).convert("RGB"); w, h = im.size
    g = Image.new("RGB", (w * 2, h * 2))
    for i in range(2):
        for j in range(2): g.paste(im, (i * w, j * h))
    g.save(sys.argv[3]); print(sys.argv[3])
elif cmd == "trim":
    # Regular grids (grout / plank / slab lines on both edges): cut T px off every side so the two
    # half lines meet as one line when repeated, then resize.
    src, out, size, t = sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
    im = Image.open(src).convert("RGB"); w, h = im.size
    im = im.crop((t, t, w - t, h - t))
    sx, sy = seam(np.asarray(im, dtype=np.float32))
    im.resize((size, size), Image.LANCZOS).save(out); print(out, f"seam after x {sx:.2f} y {sy:.2f}")
elif cmd == "crop":
    # crop an exact period box (x0 y0 x1 y1, cut through the middle of grid lines), then resize.
    src, out, size = sys.argv[2], sys.argv[3], int(sys.argv[4])
    box = tuple(int(v) for v in sys.argv[5:9])
    im = Image.open(src).convert("RGB").crop(box)
    sx, sy = seam(np.asarray(im, dtype=np.float32))
    im.resize((size, size), Image.LANCZOS).save(out); print(out, f"seam after x {sx:.2f} y {sy:.2f}")
