#!/usr/bin/env python3
"""Compose Chrome Web Store images from real product screenshots.

Deliberately no invented UI: every screenshot is a capture of the extension
running on a live logged-in feed, so the listing cannot promise something the
build does not do. Output is the store's required 1280x800 tile size plus the
440x280 small promo tile.

Usage: gen_store_images.py <media_dir>
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG = (15, 23, 42)
FG = (241, 245, 249)
MUTED = (148, 163, 184)
ACCENT = (56, 189, 248)
VIOLET = (167, 139, 250)

FONT_B = r"C:\Windows\Fonts\segoeuib.ttf"
FONT_R = r"C:\Windows\Fonts\segoeui.ttf"

TILES = [
    ("hero", "old-reddit-grid.jpg",
     "Your whole feed on one screen",
     "Twenty posts at a glance instead of five. Packed by height, so no post leaves a hole."),
    ("reddit", "new-reddit-grid.jpg",
     "Built for how Reddit actually renders",
     "Both new and old Reddit. Rails reclaimed, spacers removed, action rows kept intact."),
    ("control", "old-reddit-grid.jpg",
     "Filter, scan, expand",
     "Hide posts by keyword, strip media for pure scanning, open clamped text in place."),
]


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1],
                                           radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def wrap(draw, text, fnt, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def tile(shot_path, title, sub, logo_path, size=(1280, 800)):
    W, H = size
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # A soft accent wash so the tile is not a flat rectangle.
    glow = Image.new("RGB", (W, H), BG)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-260, -420, W // 2, 320], fill=(30, 58, 95))
    gd.ellipse([W // 2, H - 260, W + 320, H + 380], fill=(46, 32, 84))
    img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(150)), 0.85)
    d = ImageDraw.Draw(img)

    f_title = font(FONT_B, 52)
    f_sub = font(FONT_R, 26)

    x, y = 72, 68
    if os.path.exists(logo_path):
        logo = Image.open(logo_path).convert("RGBA").resize((56, 56), Image.LANCZOS)
        img.paste(logo, (x, y - 6), logo)
        d.text((x + 74, y + 8), "GridX", font=font(FONT_B, 34), fill=FG)
    y += 92

    for line in wrap(d, title, f_title, W - 144):
        d.text((x, y), line, font=f_title, fill=FG)
        y += 62
    y += 8
    for line in wrap(d, sub, f_sub, W - 200):
        d.text((x, y), line, font=f_sub, fill=MUTED)
        y += 36

    # Screenshot sits below, cropped to a wide band and rounded.
    shot = Image.open(shot_path).convert("RGB")
    target_w = W - 144
    scale = target_w / shot.width
    shot = shot.resize((target_w, int(shot.height * scale)), Image.LANCZOS)
    band_h = H - y - 60
    if band_h < 120:
        band_h = 120
    shot = shot.crop((0, 0, shot.width, min(band_h, shot.height)))
    shot = rounded(shot, 14)

    shadow = Image.new("RGBA", (shot.width + 60, shot.height + 60), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [30, 34, shot.width + 30, shot.height + 30], radius=18, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    img.paste(shadow, (x - 30, y - 30), shadow)
    img.paste(shot, (x, y), shot)

    d.rounded_rectangle([x, y, x + shot.width - 1, y + shot.height - 1],
                        radius=14, outline=(51, 65, 85), width=1)
    return img


def small_promo(logo_path):
    W, H = 440, 280
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    glow = Image.new("RGB", (W, H), BG)
    ImageDraw.Draw(glow).ellipse([-120, -160, W, 200], fill=(30, 58, 95))
    img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(70)), 0.9)
    d = ImageDraw.Draw(img)
    logo = Image.open(logo_path).convert("RGBA").resize((96, 96), Image.LANCZOS)
    img.paste(logo, (34, 58), logo)
    d.text((150, 74), "GridX", font=font(FONT_B, 44), fill=FG)
    d.text((152, 128), "High-density feed", font=font(FONT_R, 22), fill=ACCENT)
    d.text((152, 156), "dashboard", font=font(FONT_R, 22), fill=ACCENT)
    d.text((34, 206), "Reddit, packed by height.", font=font(FONT_R, 20), fill=MUTED)
    return img


def main():
    media = os.path.abspath(sys.argv[1])
    raw = os.path.join(media, "raw")
    out = os.path.join(media, "store")
    logo = os.path.join(media, "logo", "gridx-256.png")
    os.makedirs(out, exist_ok=True)

    for name, shot, title, sub in TILES:
        p = os.path.join(raw, shot)
        if not os.path.exists(p):
            print("skip %s (missing %s)" % (name, shot))
            continue
        tile(p, title, sub, logo).save(os.path.join(out, "store-%s-1280x800.png" % name))
        print("wrote store-%s-1280x800.png" % name)

    small_promo(logo).save(os.path.join(out, "promo-small-440x280.png"))
    print("wrote promo-small-440x280.png")


if __name__ == "__main__":
    main()
