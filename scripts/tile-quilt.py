# Map v2 natural tiles ("seamcut F" in art/map-v2.json): uv run --with pillow --with numpy scripts/tile-quilt.py RAW OUT SIZE F
"""Seamless tile by minimum-error seam cuts (image quilting) instead of alpha blending, so discrete
pebbles/tufts are never ghosted.  quilt.py RAW OUT SIZE [BANDFRAC]
Per axis: B = A rolled by half. In each edge band a DP path through |A-B| decides B (outer side)
vs A (inner side); path ends are pinned to the band middle so the other axis's wrap stays intact."""
import sys
import numpy as np
from PIL import Image, ImageFilter

def path_mask(err, pin):
    # err: (rows, k) cost; returns per-row cut column via DP with step -1..1; first/last `pin` rows forced to middle.
    r, k = err.shape
    big = 1e9
    e = err.copy()
    mid = k // 2
    e[:pin, :] = big; e[:pin, mid] = 0
    e[-pin:, :] = big; e[-pin:, mid] = 0
    acc = e.copy(); back = np.zeros((r, k), dtype=np.int8)
    for i in range(1, r):
        prev = acc[i - 1]
        cand = np.stack([np.r_[big, prev[:-1]], prev, np.r_[prev[1:], big]])
        j = cand.argmin(axis=0)
        acc[i] = e[i] + cand[j, np.arange(k)]
        back[i] = j - 1
    cut = np.zeros(r, dtype=int); cut[-1] = int(acc[-1].argmin())
    for i in range(r - 1, 0, -1):
        cut[i - 1] = cut[i] + back[i, cut[i]]
    return cut

def axis_fix(a, band):
    # works along columns (x); transpose for y.
    h, w, _ = a.shape
    b = np.roll(a, w // 2, axis=1)
    k = int(band * w)
    m = np.ones((h, w), dtype=np.float32)  # 1 → A, 0 → B
    err = ((a - b) ** 2).sum(axis=2)
    pin = max(4, h // 64)
    cl = path_mask(err[:, :k], pin)          # left band: B left of cut, A right
    cr = path_mask(err[:, w - k:], pin)      # right band: A left of cut, B right
    cols = np.arange(w)[None, :]
    m[cols < cl[:, None]] = 0
    m[cols >= (w - k + cr)[:, None]] = 0
    mi = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))
    m = np.asarray(mi, dtype=np.float32)[..., None] / 255
    # keep the very edges pure B so the wrap matches exactly
    m[:, :2] = 0; m[:, -2:] = 0
    return a * m + b * (1 - m)

src, out, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
band = float(sys.argv[4]) if len(sys.argv) > 4 else 0.25
a = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32)
a = axis_fix(a, band)
a = axis_fix(a.transpose(1, 0, 2), band).transpose(1, 0, 2)
im = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
im.resize((size, size), Image.LANCZOS).save(out)
print(out)
