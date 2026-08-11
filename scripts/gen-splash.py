#!/usr/bin/env python3
"""Regenerate the iOS launch images and their <link> tags.

    python3 scripts/gen-splash.py          # writes web/public/splash/ + prints links

Without apple-touch-startup-image, iOS shows a blank field on cold start of an
installed app. The media query must match the device EXACTLY — a near miss is
silently ignored — so the table below is real CSS point sizes, and every entry is
a DISTINCT viewport+DPR rather than a marketing name. Devices that share a
viewport share an image, which is why the 12/13/14 line and the 15/16 line each
appear once.

Adding a device: add a row, re-run, paste the printed links into web/index.html.
Requires cairosvg (pip install cairosvg).
"""
import sys
from pathlib import Path

BG, INK = "#0b0e14", "#8b93f8"
STARS = [(71, 40, 2.5), (66, 22, 3.0), (45, 15, 3.75), (28, 27, 4.25), (50, 50, 5.25),
         (72, 73, 4.25), (55, 85, 3.75), (34, 78, 3.0), (29, 60, 2.5)]
SPINE = "M71 40 L66 22 L45 15 L28 27 L50 50 L72 73 L55 85 L34 78 L29 60"

# (slug, css portrait width, css portrait height, device pixel ratio)
DEVICES = [
    ("iphone-se",       375,  667, 2),   # SE 2nd/3rd, 8
    ("iphone-8plus",    414,  736, 3),
    ("iphone-x",        375,  812, 3),   # X, XS, 11 Pro, 12/13 mini
    ("iphone-xr",       414,  896, 2),   # XR, 11
    ("iphone-xsmax",    414,  896, 3),   # XS Max, 11 Pro Max
    ("iphone-12",       390,  844, 3),   # 12, 12 Pro, 13, 13 Pro, 14
    ("iphone-12promax", 428,  926, 3),   # 12/13 Pro Max, 14 Plus
    ("iphone-14pro",    393,  852, 3),   # 14 Pro, 15, 15 Pro, 16
    ("iphone-14promax", 430,  932, 3),   # 14 Pro Max, 15 Plus, 15/16 Pro Max… see 16promax
    ("iphone-16pro",    402,  874, 3),
    ("iphone-16promax", 440,  956, 3),
    ("ipad-9-7",        768, 1024, 2),   # 9.7", 10.2"
    ("ipad-mini",       744, 1133, 2),
    ("ipad-10-9",       820, 1180, 2),   # iPad 10th gen, Air 11" M2
    ("ipad-air-10-5",   834, 1112, 2),   # Air 10.5", Pro 10.5"
    ("ipad-pro-11",     834, 1194, 2),   # Pro 11" 1st–4th gen
    ("ipad-pro-11-m4",  834, 1210, 2),
    ("ipad-pro-12-9",  1024, 1366, 2),   # Pro 12.9" 1st–6th gen
    ("ipad-pro-13-m4", 1032, 1376, 2),
]


def svg(w: int, h: int) -> str:
    """The constellation mark on the manifest's background_color, so the hand-off
    from splash to app shell is seamless rather than a flash."""
    m = min(w, h) * 0.20
    x, y = (w - m) / 2, (h - m) / 2 - min(w, h) * 0.04
    s = m / 100
    dots = "".join(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{INK}"/>' for cx, cy, r in STARS)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <rect width="{w}" height="{h}" fill="{BG}"/>
  <g transform="translate({x},{y}) scale({s})">
    <path d="{SPINE}" fill="none" stroke="{INK}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    {dots}
  </g>
  <text x="{w/2}" y="{y + m + min(w,h)*0.045}" text-anchor="middle" fill="#6b7280"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="{min(w,h)*0.035}" letter-spacing="{min(w,h)*0.012}">SIGIL</text>
</svg>'''


def main() -> int:
    try:
        import cairosvg
    except ImportError:
        print("cairosvg is required: pip install cairosvg", file=sys.stderr)
        return 1

    out = Path(__file__).resolve().parent.parent / "web" / "public" / "splash"
    out.mkdir(parents=True, exist_ok=True)
    links = []
    for slug, cw, ch, dpr in DEVICES:
        pw, ph = cw * dpr, ch * dpr
        for orient, (w, h) in (("portrait", (pw, ph)), ("landscape", (ph, pw))):
            name = f"{slug}-{orient}.png"
            cairosvg.svg2png(bytestring=svg(w, h).encode(), write_to=str(out / name),
                             output_width=w, output_height=h)
            # device-width/height stay at the PORTRAIT values in both orientations —
            # that is how iOS evaluates them; only `orientation` differentiates.
            links.append(
                f'    <link rel="apple-touch-startup-image" href="/splash/{name}"\n'
                f'      media="(device-width: {cw}px) and (device-height: {ch}px) and '
                f'(-webkit-device-pixel-ratio: {dpr}) and (orientation: {orient})" />'
            )
    print("\n".join(links))
    print(f"\n{len(DEVICES)} devices -> {len(DEVICES) * 2} images in {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
