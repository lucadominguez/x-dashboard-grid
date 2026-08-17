#!/usr/bin/env python3
"""Generate GridX extension icons + store listing images (PIL only, no deps).
Dark rounded square with a cyan grid glyph (3 cols x 2 rows of lines)."""
import math
from PIL import Image, ImageDraw

def rounded_rect(draw, xy, radius, fill):
    draw.rounded_rectangle(xy, radius=radius, fill=fill)

def draw_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * 0.06
    radius = size * 0.18
    # dark background
    bg = (15, 17, 22, 255)
    rounded_rect(d, [pad, pad, size - pad, size - pad], radius, bg)
    # subtle border
    border = (60, 66, 82, 255)
    rounded_rect(d, [pad, pad, size - pad, size - pad], radius, None) if False else None
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, outline=border, width=max(1, int(size*0.02)))
    # cyan grid glyph: 3 columns x 2 rows
    cyan = (0, 229, 255, 255)
    x0, x1 = size*0.24, size*0.76
    y0, y1 = size*0.32, size*0.68
    lw = max(2, int(size*0.06))
    # vertical dividers -> 3 columns
    for i in range(4):
        fx = x0 + (x1-x0) * i / 3
        d.line([fx, y0, fx, y1], fill=cyan, width=lw)
    # horizontal divider -> 2 rows
    fy = y0 + (y1-y0) / 2
    d.line([x0, fy, x1, fy], fill=cyan, width=lw)
    # corner accent
    d.rectangle([size*0.20, size*0.22, size*0.20+size*0.16, size*0.22+size*0.12], fill=(0,229,255,255))
    img.save(path)
    print("wrote", path, img.size)

draw_icon(16, "/root/gridx-store/extension/icons/icon16.png")
draw_icon(48, "/root/gridx-store/extension/icons/icon48.png")
draw_icon(128, "/root/gridx-store/extension/icons/icon128.png")
# A 128x128 marketing icon used for the store listing (Chrome uses up to 128)
draw_icon(128, "/root/gridx-store/images/marquee128.png")
print("done")
