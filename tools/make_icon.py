"""Erzeugt assets/icon.ico, icon.png und icon.svg: vier Spalten, die sich nach rechts aufklappen (breiter werden),
die letzte mit Play-Dreieck. Aufruf: python tools/make_icon.py  (benötigt: pip install pillow)"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets"
S = 1024                                   # Zeichenfläche
BG, ACCENT = "#0b0f0b", "#b6f2b6"          # Hintergrund und Akzent wie im terminal-Theme
COLORS = ["#2f5a35", "#4f8f58", "#82c98d", ACCENT]
WIDTHS = [60, 110, 180, 280]
GAP, TOP, BOTTOM, R_BAR, R_ICON = 36, 232, 792, 26, 224

total = sum(WIDTHS) + GAP * (len(WIDTHS) - 1)
bars, x = [], (S - total) // 2
for w in WIDTHS:
    bars.append((x, TOP, x + w, BOTTOM))
    x += w + GAP
cx, cy = (bars[-1][0] + bars[-1][2]) // 2, (TOP + BOTTOM) // 2
tri = [(cx - 46, cy - 76), (cx - 46, cy + 76), (cx + 62, cy)]  # Play-Dreieck in der letzten Spalte


def render(size: int) -> Image.Image:
    k = 4                                  # Supersampling für glatte Kanten
    img = Image.new("RGBA", (S * k, S * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, S * k - 1, S * k - 1), R_ICON * k, fill=BG)
    for box, col in zip(bars, COLORS):
        d.rounded_rectangle([v * k for v in box], R_BAR * k, fill=col)
    d.polygon([(px * k, py * k) for px, py in tri], fill=BG)
    return img.resize((size, size), Image.LANCZOS)


def svg() -> str:
    rects = "".join(f'<rect x="{b[0]}" y="{b[1]}" width="{b[2]-b[0]}" height="{b[3]-b[1]}" rx="{R_BAR}" fill="{c}"/>'
                    for b, c in zip(bars, COLORS))
    pts = " ".join(f"{px},{py}" for px, py in tri)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}"><rect width="{S}" height="{S}" rx="{R_ICON}" fill="{BG}"/>'
            f'{rects}<polygon points="{pts}" fill="{BG}"/></svg>\n')


OUT.mkdir(exist_ok=True)
render(1024).save(OUT / "icon.png")
render(256).save(OUT / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
(OUT / "icon.svg").write_text(svg(), encoding="utf-8")
print("OK ->", OUT)
