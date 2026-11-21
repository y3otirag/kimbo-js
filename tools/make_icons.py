#!/usr/bin/env python3
"""Generate Kimbo JS PNG icons (original mark). Run from the project root."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "assets" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (10, 16, 11, 255)
PANEL = (17, 26, 19, 255)
LINE = (49, 69, 53, 255)
ACID = (200, 255, 61, 255)
EMBER = (255, 112, 67, 255)


def render(size: int) -> Image.Image:
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(3 * scale, int(s * 0.16))
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG, outline=LINE, width=max(1, scale))

    # Subtle inner panel
    inset = int(s * 0.08)
    d.rounded_rectangle(
        [inset, inset, s - inset - 1, s - inset - 1],
        radius=max(2 * scale, int(radius * 0.8)),
        outline=(28, 43, 32, 255),
        width=max(1, scale // 2),
    )

    # K strokes
    stroke = max(2 * scale, int(s * 0.115))
    x = int(s * 0.28)
    top = int(s * 0.20)
    bottom = int(s * 0.80)
    mid = int(s * 0.52)
    d.line([(x, top), (x, bottom)], fill=ACID, width=stroke)
    d.line([(x, mid), (int(s * 0.66), top)], fill=ACID, width=stroke)
    d.line([(x, mid), (int(s * 0.69), bottom)], fill=ACID, width=stroke)

    # Node dot
    r = max(1.4 * scale, int(s * 0.072))
    cx, cy = int(s * 0.77), int(s * 0.22)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=EMBER)

    return img.resize((size, size), Image.LANCZOS)


def main():
    for size in (16, 32, 48, 128):
        icon = render(size)
        icon.save(OUT / f"icon{size}.png")
        print(f"wrote {OUT / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
