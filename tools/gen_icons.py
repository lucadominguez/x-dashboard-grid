#!/usr/bin/env python3
"""Generate GridX PNG icons programmatically (pure stdlib).

Draws a dark rounded square with a cyan "grid" glyph (3 columns x 2 rows of
lines) as specified in BUILD_BRIEF.md section 7. Writes icons/icon16.png,
icons/icon48.png, icons/icon128.png.

Uses only struct + zlib to emit a valid PNG (no Pillow dependency).
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, os.pardir, "icons")

# Theme
BG = (21, 32, 43, 255)          # dark slate (#15202b)
GRID = (29, 161, 242, 255)      # cyan-ish X blue (#1d9bf0)
GRID_DIM = (88, 154, 208, 255)  # slightly dimmer for secondary lines


def png_bytes(width, height, pixel_rgba):
    """pixel_rgba: nested list rows x cols, each a (r,g,b,a) tuple."""
    raw = b""
    for row in pixel_rgba:
        raw += b"\x00" + b"".join(struct.pack("4B", *px) for px in row)
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        return c
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def rounded_rect(cx, cy, half, radius):
    """True if (cx,cy) inside rounded square centered on half-extent `half`."""
    x0, y0 = -half, -half
    x1, y1 = half, half
    if cx < x0 or cx > x1 or cy < y0 or cy > y1:
        return False
    # Corner rounding: clamp to nearest corner, then within radius.
    nx = max(x0 + radius, min(cx, x1 - radius))
    ny = max(y0 + radius, min(cy, y1 - radius))
    dx, dy = cx - nx, cy - ny
    return dx * dx + dy * dy <= radius * radius


def render(size):
    half = size - 1
    radius = max(1, int(size * 0.22))
    # Grid glyph geometry: a centered square occupying 62% of the icon, split
    # into 3 columns x 2 rows. Lines are ~10% of size wide.
    g = size * 0.62
    top = (size - g) / 2.0
    line = max(1.0, size * 0.09)
    rows_f = [top + g / 3.0, top + 2.0 * g / 3.0]     # 2 horizontal dividers
    cols_f = [top + g / 3.0, top + 2.0 * g / 3.0]     # 2 vertical dividers

    px = [[BG] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            if not rounded_rect(x, y, half, radius):
                continue
            # grid cell coordinates (grow outward from center row 0 for density)
            color = None
            # vertical dividers
            for c in cols_f:
                if abs(x - c) <= line / 2:
                    color = GRID
            # horizontal dividers (slightly dimmer to read as "rows")
            for r in rows_f:
                if abs(y - r) <= line / 2:
                    color = GRID_DIM if color is None else GRID
            if color is not None:
                px[y][x] = color
    return px


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 48, 128):
        pix = render(size)
        data = png_bytes(size, size, pix)
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        with open(path, "wb") as f:
            f.write(data)
        print("wrote %s (%d bytes)" % (path, len(data)))
    print("done")


if __name__ == "__main__":
    main()