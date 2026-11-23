#!/usr/bin/env python3
"""Scan Kit App Store screenshots: headline on the brand colour, the app
screen in a device frame that runs off the bottom edge.

  python3 compose.py iphone|ipad VERB "DESCRIPTOR" raw.png out.png

iPhone: 1320 x 2868 (6.9" slot). iPad: 2048 x 2732 (13" slot).
"""
import sys
from PIL import Image, ImageDraw, ImageFont

BG = (10, 138, 156)          # #0A8A9C, the app's accent
BLACK = "/Library/Fonts/SF-Pro-Display-Black.otf"
HEAVY = "/Library/Fonts/SF-Pro-Display-Heavy.otf"

SPECS = {
    # canvas, verb size, desc size, text top, device width, bezel, corner radius
    "iphone": dict(W=1320, H=2868, verb=250, desc=96, top=170, dev_w=1060, bezel=26, radius=150),
    "play":   dict(W=1440, H=2560, verb=230, desc=88, top=150, dev_w=1080, bezel=26, radius=150),
    "tablet": dict(W=1620, H=2880, verb=240, desc=96, top=170, dev_w=1500, bezel=30, radius=64),
    "ipad":   dict(W=2048, H=2732, verb=250, desc=104, top=150, dev_w=1640, bezel=34, radius=70),
}


def wrap(draw, text, font, max_w):
    words = text.split()
    if draw.textlength(text, font=font) <= max_w:
        return [text]
    # Two balanced lines when they fit: the split with the narrowest widest line.
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        w = max(draw.textlength(a, font=font), draw.textlength(b, font=font))
        if w <= max_w and (best is None or w < best[0]):
            best = (w, [a, b])
    if best:
        return best[1]
    lines, cur = [], ""
    for w in words:
        t = f"{cur} {w}".strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def compose(kind, verb, desc, shot_path, out_path):
    s = SPECS[kind]
    W, H = s["W"], s["H"]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Headline
    y = s["top"]
    vf = ImageFont.truetype(BLACK, s["verb"])
    while d.textlength(verb, font=vf) > W * 0.86:
        vf = ImageFont.truetype(BLACK, vf.size - 8)
    b = d.textbbox((0, 0), verb, font=vf)
    d.text((W / 2, y - b[1]), verb, font=vf, fill="white", anchor="mt")
    y += b[3] - b[1] + 44
    df = ImageFont.truetype(HEAVY, s["desc"])
    for line in wrap(d, desc, df, W * 0.80):
        b = d.textbbox((0, 0), line, font=df)
        d.text((W / 2, y - b[1]), line, font=df, fill=(255, 255, 255), anchor="mt")
        y += b[3] - b[1] + 26
    text_bottom = y

    # Device: black body with rounded corners, screen inset by the bezel.
    dev_w = s["dev_w"]
    bezel = s["bezel"]
    dev_x = (W - dev_w) // 2
    dev_y = text_bottom + 80
    scr_w = dev_w - 2 * bezel
    shot = Image.open(shot_path).convert("RGB")
    scr_h = round(shot.height * scr_w / shot.width)
    shot = shot.resize((scr_w, scr_h), Image.LANCZOS)

    # soft shadow
    shadow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        [dev_x, dev_y + 30, dev_x + dev_w, (H + 400) if dev_y + bezel + scr_h >= H else dev_y + 2 * bezel + scr_h + 30], radius=s["radius"], fill=90)
    from PIL import ImageFilter
    shadow = shadow.filter(ImageFilter.GaussianBlur(40))
    img.paste((0, 40, 50), (0, 0), shadow)

    # The device runs off the bottom edge, or ends with rounded corners when
    # its screen is shorter than the space left (a 3:4 iPad on a 9:16 canvas).
    dev_bottom = H + 400 if dev_y + bezel + scr_h >= H else dev_y + 2 * bezel + scr_h
    body = Image.new("L", (W, H), 0)
    ImageDraw.Draw(body).rounded_rectangle(
        [dev_x, dev_y, dev_x + dev_w, dev_bottom], radius=s["radius"], fill=255)
    img.paste((18, 18, 20), (0, 0), body)

    scr_x, scr_y = dev_x + bezel, dev_y + bezel
    mask = Image.new("L", (scr_w, scr_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, scr_w - 1, (scr_h + 400) if dev_y + bezel + scr_h >= H else scr_h - 1], radius=s["radius"] - bezel, fill=255)
    img.paste(shot, (scr_x, scr_y), mask)

    img.save(out_path, "PNG")
    print(f"{out_path} {W}x{H}")


if __name__ == "__main__":
    compose(*sys.argv[1:6])
