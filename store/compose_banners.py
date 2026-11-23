#!/usr/bin/env python3
"""Header (3840 x 1646) and Search Results (3840 x 2560) assets for the
App Store product page, in the screenshots' style."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BG = (10, 138, 156)
BLACK = "/Library/Fonts/SF-Pro-Display-Black.otf"
HEAVY = "/Library/Fonts/SF-Pro-Display-Heavy.otf"


def phone(shot_path, width):
    """A phone mockup (RGBA) of the screenshot, `width` px wide."""
    shot = Image.open(shot_path).convert("RGB")
    bezel = round(width * 0.025)
    radius = round(width * 0.14)
    scr_w = width - 2 * bezel
    scr_h = round(shot.height * scr_w / shot.width)
    h = scr_h + 2 * bezel
    out = Image.new("RGBA", (width, h), (0, 0, 0, 0))
    body = Image.new("L", (width, h), 0)
    ImageDraw.Draw(body).rounded_rectangle([0, 0, width - 1, h - 1], radius=radius, fill=255)
    out.paste((18, 18, 20, 255), (0, 0), body)
    mask = Image.new("L", (scr_w, scr_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, scr_w - 1, scr_h - 1], radius=radius - bezel, fill=255)
    out.paste(shot.resize((scr_w, scr_h), Image.LANCZOS), (bezel, bezel), mask)
    return out


def place(canvas, ph, cx, top):
    """Paste a phone centred on cx with a soft shadow."""
    x = round(cx - ph.width / 2)
    sh = Image.new("L", canvas.size, 0)
    a = ph.split()[3]
    sh.paste(a.point(lambda v: 110 if v else 0), (x + 10, top + 40))
    sh = sh.filter(ImageFilter.GaussianBlur(45))
    canvas.paste((0, 45, 55), (0, 0), sh)
    canvas.paste(ph, (x, top), ph)


def header(out):
    W, H = 3840, 1646
    c = Image.new("RGB", (W, H), BG)
    shots = ["raw/iphone/06-tools.png", "raw/iphone/07-find.png", "raw/iphone/04-viewer.png",
             "raw/iphone/08-sign.png", "raw/iphone/02-files.png"]
    widths = [560, 640, 740, 640, 560]
    xs = [W / 2 - 1300, W / 2 - 680, W / 2, W / 2 + 680, W / 2 + 1300]
    tops = [330, 230, 130, 230, 330]
    order = [0, 4, 1, 3, 2]  # middle phone last, on top
    for i in order:
        place(c, phone(shots[i], widths[i]), xs[i], tops[i])
    c.save(out)
    print(out, c.size)


def search(out):
    W, H = 3840, 2560
    c = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(c)
    f1 = ImageFont.truetype(BLACK, 230)
    f2 = ImageFont.truetype(HEAVY, 120)
    d.text((W / 2, 170), "SCAN. FIND. SIGN.", font=f1, fill="white", anchor="mt")
    d.text((W / 2, 450), "ALL ON YOUR PHONE. NO ACCOUNT, NO CLOUD.", font=f2, fill="white", anchor="mt")
    shots = ["raw/iphone/04-viewer.png", "raw/iphone/07-find.png", "raw/iphone/08-sign.png"]
    for s, cx in zip(shots, [W / 2 - 1080, W / 2, W / 2 + 1080]):
        place(c, phone(s, 900), cx, 760)
    c.save(out)
    print(out, c.size)


if __name__ == "__main__":
    header("final/header-3840x1646.png")
    search("final/search-results-3840x2560.png")


def feature(out):
    """Google Play feature graphic, 1024 x 500."""
    W, H = 1024, 500
    c = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(c)
    d.text((60, 150), "Scan Kit", font=ImageFont.truetype(BLACK, 92), fill="white", anchor="lt")
    f2 = ImageFont.truetype(HEAVY, 36)
    d.text((62, 268), "Scan, find and sign PDFs.", font=f2, fill="white", anchor="lt")
    d.text((62, 314), "All on your phone.", font=f2, fill="white", anchor="lt")
    place(c, phone("raw/iphone/07-find.png", 190), 700, 120)
    place(c, phone("raw/iphone/04-viewer.png", 210), 880, 70)
    c.save(out)
    print(out, c.size)


if __name__ == "__main__" and "feature" in __import__("sys").argv:
    feature("final/play/feature-1024x500.png")
