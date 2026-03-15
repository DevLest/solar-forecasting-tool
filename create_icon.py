#!/usr/bin/env python3
"""Create solar-automation icon PNG in assets/ (run once, then optional: delete this script)."""
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Install Pillow: pip install Pillow")
    raise

SIZE = 256
ASSETS = Path(__file__).resolve().parent / "assets"
ASSETS.mkdir(exist_ok=True)

# Dark blue background, amber sun, teal accent
BG = (15, 23, 42)       # #0f172a
SUN = (255, 176, 32)    # #FFB020
ACCENT = (0, 217, 255)  # #00d9ff
WHITE = (255, 255, 255)

img = Image.new("RGB", (SIZE, SIZE), BG)
draw = ImageDraw.Draw(img)

cx, cy = SIZE // 2, SIZE // 2

# Sun circle
sun_r = 52
draw.ellipse((cx - sun_r, cy - sun_r - 10, cx + sun_r, cy + sun_r - 10), fill=SUN, outline=ACCENT, width=3)

# Sun rays (8 short rays)
import math
for i in range(8):
    a = math.pi * 2 * i / 8
    r1, r2 = sun_r + 8, sun_r + 28
    x1 = cx + r1 * math.cos(a)
    y1 = cy - 10 + r1 * math.sin(a)
    x2 = cx + r2 * math.cos(a)
    y2 = cy - 10 + r2 * math.sin(a)
    draw.line([(x1, y1), (x2, y2)], fill=SUN, width=4)

# Terminal bracket/prompt below sun (">_")
draw.rounded_rectangle((cx - 70, cy + 35, cx + 70, cy + 75), radius=8, outline=ACCENT, width=3)
draw.text((cx - 55, cy + 42), ">_", fill=WHITE)

out = ASSETS / "solar-automation-icon.png"
img.save(out, "PNG")
print(f"Saved: {out}")
