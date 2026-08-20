#!/usr/bin/env python3
"""Draw the GridX mark and write every size the extension and store need.

The mark IS the product: unequal blocks packed into columns with no wasted
vertical space, which is exactly what the extension does to a feed. It is
drawn rather than rasterised from SVG because the 16px favicon has to survive
pixel snapping, and at that size a three-column mark turns to mush - so small
sizes get a deliberately simplified two-column cut.

Usage: gen_logo.py <out_dir> [<extension_icons_dir>]
"""
import os
import sys

from PIL import Image, ImageDraw

BG = (15, 23, 42, 255)        # slate-900, reads on both light and dark toolbars
BLOCK = (56, 189, 248, 255)   # sky-400
ACCENT = (167, 139, 250, 255) # violet-400, one block so the mark has a subject

# Column-major block layout as (column, top, height) in a 0..1 square, chosen so
# the columns are visibly UNEVEN - an even grid would read as a table, not as
# packed content.
# Deliberately 2 / 3 / 2 blocks with NO shared horizontal boundary. The first
# cut used three equal-ish blocks per column and three of them lined up into a
# false row, so the mark read as a generic nine-square app-grid icon rather
# than as packed content of unequal heights.
LAYOUT_FULL = [
    (0, 0.00, 0.46), (0, 0.53, 0.47),
    (1, 0.00, 0.21), (1, 0.28, 0.36), (1, 0.71, 0.29),
    (2, 0.00, 0.33), (2, 0.40, 0.60),
]
ACCENT_INDEX = 3

# At 16px three columns turn to mush, so the small cut keeps two columns and
# leans harder on the height difference that is the whole idea.
LAYOUT_SMALL = [
    (0, 0.00, 0.40), (0, 0.50, 0.50),
    (1, 0.00, 0.62), (1, 0.72, 0.28),
]
ACCENT_INDEX_SMALL = 2


def draw(size):
    # Supersample everything except the corner radius maths, then downsample.
    ss = 8 if size < 64 else 4
    px = size * ss
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, px - 1, px - 1], radius=int(px * 0.22), fill=BG)

    small = size < 40
    layout = LAYOUT_SMALL if small else LAYOUT_FULL
    accent = ACCENT_INDEX_SMALL if small else ACCENT_INDEX
    cols = 2 if small else 3

    pad = px * (0.18 if small else 0.16)
    inner = px - 2 * pad
    gap = inner * (0.10 if small else 0.075)
    col_w = (inner - gap * (cols - 1)) / cols
    radius = max(1, int(col_w * 0.22))

    for i, (col, top, h) in enumerate(layout):
        x0 = pad + col * (col_w + gap)
        y0 = pad + top * inner
        y1 = y0 + h * inner
        d.rounded_rectangle([x0, y0, x0 + col_w, y1],
                            radius=radius,
                            fill=ACCENT if i == accent else BLOCK)

    return img.resize((size, size), Image.LANCZOS)


def main():
    out = os.path.abspath(sys.argv[1])
    os.makedirs(out, exist_ok=True)
    sizes = [16, 32, 48, 64, 128, 256, 512]
    for s in sizes:
        img = draw(s)
        img.save(os.path.join(out, "gridx-%d.png" % s))
        print("wrote gridx-%d.png" % s)

    # A wordmark strip for the store header and the README.
    w, h = 1400, 360
    banner = Image.new("RGBA", (w, h), BG)
    mark = draw(200)
    banner.paste(mark, (110, (h - 200) // 2), mark)
    banner.save(os.path.join(out, "gridx-banner.png"))
    print("wrote gridx-banner.png")

    if len(sys.argv) > 2:
        icons = os.path.abspath(sys.argv[2])
        os.makedirs(icons, exist_ok=True)
        for s in (16, 48, 128):
            draw(s).save(os.path.join(icons, "icon%d.png" % s))
            print("wrote extension icon%d.png" % s)


if __name__ == "__main__":
    main()
