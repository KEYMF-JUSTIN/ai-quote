"""
Build app icons (favicon .ico + PNG + SVG) from the inline logo used in
the AI Quote app header. The logo is: navy rounded-arch outline (the
Keystone arch), a white touch-probe body inside, and an orange ruby
touch ball at the tip. Pillow draws everything directly — no SVG
rasterizer dependency.

Outputs:
  icons/ai-quote.svg         scalable, used by modern browsers for the
                             tab favicon (link rel="icon" type="image/svg+xml")
  icons/ai-quote.png         256x256, used for apple-touch-icon and PWA install
  icons/ai-quote.ico         multi-resolution (16/32/48/64/128/256) for
                             classic favicon and Windows desktop shortcuts

Run:
  python scripts/build_app_icon.py
"""
from PIL import Image, ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICONS_DIR = ROOT / "icons"
ICONS_DIR.mkdir(exist_ok=True)

# Colors — match index.html theme tokens
NAVY = (31, 41, 55, 255)         # --navy #1F2937 (background tile)
WHITE = (255, 255, 255, 255)
ORANGE = (220, 67, 24, 255)      # --orange #DC4318 (ruby touch ball)


def draw_icon(size: int) -> Image.Image:
    """Render the logo at the given square pixel size."""
    img = Image.new("RGBA", (size, size), NAVY)
    d = ImageDraw.Draw(img)

    # Optional: round the icon corners on the background tile so it
    # looks app-like (Android/iOS conventions). Skip on tiny sizes
    # where rounding turns to mush.
    if size >= 48:
        # Mask-based rounded corner. Easier than per-pixel.
        radius = max(4, size // 8)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
        bg = Image.new("RGBA", (size, size), NAVY)
        img = Image.composite(bg, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask)
        d = ImageDraw.Draw(img)

    # All geometry below is in a 80x70 logical viewBox (matches the
    # inline SVG). Convert with a scale factor and centering.
    vb_w, vb_h = 80.0, 70.0
    # Inset the artwork so it doesn't kiss the edges of the tile.
    pad = size * 0.08
    avail = size - 2 * pad
    scale = min(avail / vb_w, avail / vb_h)
    art_w = vb_w * scale
    art_h = vb_h * scale
    ox = (size - art_w) / 2
    oy = (size - art_h) / 2

    def sx(x): return ox + x * scale
    def sy(y): return oy + y * scale

    # Stroke width — proportional, with a sensible minimum so small
    # favicons stay visible.
    sw = max(1, int(round(3.2 * scale)))

    # 1. Keystone arch outline. The SVG path is:
    #     M 6 66 L 6 22 Q 6 6 22 6 L 58 6 Q 74 6 74 22 L 74 66 Z
    # Two straight side walls + two top quarter-arcs + a straight bottom.
    # Pillow has no path API but we can compose: left wall, left arc,
    # top, right arc, right wall, bottom.
    arch_color = WHITE
    # Left wall
    d.line([(sx(6), sy(66)), (sx(6), sy(22))], fill=arch_color, width=sw)
    # Left top arc: center (22,22), radius 16, 180→270deg
    d.arc(
        [sx(22 - 16), sy(22 - 16), sx(22 + 16), sy(22 + 16)],
        start=180, end=270, fill=arch_color, width=sw,
    )
    # Top straight
    d.line([(sx(22), sy(6)), (sx(58), sy(6))], fill=arch_color, width=sw)
    # Right top arc: center (58,22), radius 16, 270→360
    d.arc(
        [sx(58 - 16), sy(22 - 16), sx(58 + 16), sy(22 + 16)],
        start=270, end=360, fill=arch_color, width=sw,
    )
    # Right wall
    d.line([(sx(74), sy(22)), (sx(74), sy(66))], fill=arch_color, width=sw)
    # Bottom straight (closes the path)
    d.line([(sx(6), sy(66)), (sx(74), sy(66))], fill=arch_color, width=sw)

    # 2. Probe body — solid white rectangle, 32-48 x 13-25 in viewBox.
    d.rectangle([sx(32), sy(13), sx(48), sy(25)], fill=WHITE)

    # 3. Probe collar / mount — thin horizontal bar 28-52 x 25-28.
    d.rectangle([sx(28), sy(25), sx(52), sy(28)], fill=WHITE)

    # 4. Probe stem — thin vertical bar 39-41 x 28-50.
    d.rectangle([sx(39), sy(28), sx(41), sy(50)], fill=WHITE)

    # 5. Ruby touch ball at the tip — orange circle, center (40,53), r=4.
    r = 4 * scale
    d.ellipse(
        [sx(40) - r, sy(53) - r, sx(40) + r, sy(53) + r],
        fill=ORANGE, outline=WHITE, width=max(1, int(scale)),
    )

    return img


def build_svg() -> str:
    """The same artwork as a scalable SVG for modern browser favicons.
    Mirrors the inline header SVG but with a navy rounded-rect background
    so it reads on white browser tabs."""
    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 70" width="80" height="70">
  <rect x="0" y="0" width="80" height="70" rx="8" ry="8" fill="#1F2937"/>
  <path d="M 6 66 L 6 22 Q 6 6 22 6 L 58 6 Q 74 6 74 22 L 74 66 Z"
        fill="none" stroke="#FFFFFF" stroke-width="3.2"
        stroke-linejoin="round" stroke-linecap="round"/>
  <rect x="32" y="13" width="16" height="12" fill="#FFFFFF" rx="1"/>
  <rect x="28" y="25" width="24" height="3" fill="#FFFFFF"/>
  <rect x="39" y="28" width="2" height="22" fill="#FFFFFF"/>
  <circle cx="40" cy="53" r="4" fill="#DC4318" stroke="#FFFFFF" stroke-width="1"/>
</svg>
"""


def main():
    # 1. SVG
    svg_path = ICONS_DIR / "ai-quote.svg"
    svg_path.write_text(build_svg(), encoding="utf-8")
    print(f"wrote {svg_path}")

    # 2. PNG (256, single large for PWA / apple-touch-icon)
    png_big = draw_icon(256)
    png_path = ICONS_DIR / "ai-quote.png"
    png_big.save(png_path, format="PNG", optimize=True)
    print(f"wrote {png_path}")

    # 3. ICO (multi-res for Windows + classic favicon)
    sizes = [16, 32, 48, 64, 128, 256]
    images = [draw_icon(s) for s in sizes]
    ico_path = ICONS_DIR / "ai-quote.ico"
    # Pillow's .ico writer takes the first image and a list of sizes,
    # OR a list of images via append_images. Use the largest as the
    # primary and let Pillow scale the rest from append_images.
    images[-1].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=images[:-1],
    )
    print(f"wrote {ico_path}  (sizes: {sizes})")

    # 4. Apple-touch-180 (PWA on iOS likes this exact size). Optional.
    apple = draw_icon(180)
    apple_path = ICONS_DIR / "apple-touch-icon.png"
    apple.save(apple_path, format="PNG", optimize=True)
    print(f"wrote {apple_path}")


if __name__ == "__main__":
    main()
