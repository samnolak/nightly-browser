#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Generate Nightly Browser branding from the owner's transparent artwork.

nightly-artwork.png is the cleaned 2026-10-20 artwork: detected bounds in the
1254px original were (81, 71)-(1170, 1140). The exterior black matte was
removed, the contour smoothed and edge RGB un-matted before resampling.
The original aspect ratio is preserved; macOS uses an 824px-wide tile on
a 1024px transparent canvas. Both channels share the owner's app artwork.
Private browsing retains its separate closed-eye symbol. Wordmark outlines
come from Outfit (SIL Open Font License 1.1).

Outputs (per brand dir in configs/branding/<brand>/, same names, pixel sizes
and container formats as the Zen files they replaced):
  logo{16..1024}.png, logo.png, logo-mac.png, firefox.icns, firefox.ico,
  firefox64.ico, document.ico, document_pdf.ico, pbmode.ico,
  VisualElements_{70,150}.png, PrivateBrowsing_{70,150}.png, wizWatermark.bmp,
  MacOSInstaller.svg, content/about-logo{,@2x}.png, content/about-logo.svg,
  content/about-logo-private{,@2x}.png, content/about-logo-private.svg,
  content/about-wordmark.svg, content/firefox-wordmark.svg
plus configs/branding/nightly-logo.svg (master icon, also the Flatpak icon in
build/flatpak/metadata/icons/) and the README lockups in docs/assets/.

Run from the repo root (needs Pillow and resvg-py; macOS `iconutil` is used
for .icns when present, Pillow otherwise):
  uv run --with pillow --with resvg-py python3 scripts/nightly_branding.py
Optional: --preview PATH writes a contact sheet of the generated assets.
"""

import argparse
import base64
import io
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass

try:
  import resvg_py
  from PIL import Image
except ImportError:
  sys.exit("Needs Pillow and resvg-py: uv run --with pillow --with resvg-py "
           "python3 scripts/nightly_branding.py")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRANDING = os.path.join(ROOT, "configs", "branding")
DOCS_ASSETS = os.path.join(ROOT, "docs", "assets")
FLATPAK_ICON = os.path.join(ROOT, "build", "flatpak", "metadata", "icons",
                            "io.github.samnolak.nightly.svg")
with open(os.path.join(BRANDING, "nightly-artwork.png"), "rb") as artwork:
  ARTWORK_URI = "data:image/png;base64," + base64.b64encode(artwork.read()).decode("ascii")


@dataclass(frozen=True)
class Palette:
  tile_top: str
  tile_bottom: str
  glow: str
  moon_light: str
  moon_dark: str
  wordmark_suffix: str  # extra word after "Nightly" in wordmarks ("" or "Beta")


PALETTES = {
    "release": Palette("#2B3474", "#0B0D2A", "#8FA2FF", "#FFF7DE", "#F2C46A", ""),
    "twilight": Palette("#9A3F78", "#261447", "#FF9FC8", "#FFF7DE", "#F7B26A", "Beta"),
}
PRIVATE = Palette("#5B34A8", "#1C0D3F", "#C8A8FF", "#F6EEFF", "#D9C2FF", "")

# Pixel sizes of the raster assets, per brand (kept identical to the files
# these replace so nothing downstream changes).
COMMON_SIZES = {
    "logo16.png": 16, "logo22.png": 22, "logo24.png": 24, "logo32.png": 32,
    "logo48.png": 48, "logo64.png": 64, "logo128.png": 128,
    "logo256.png": 256, "logo512.png": 512, "logo1024.png": 1024,
    "logo.png": 1024,
}
BRAND_SIZES = {
    "release": {"logo-mac.png": 1024, "VisualElements_150.png": (1042, 1046),
                "VisualElements_70.png": (1042, 1046)},
    "twilight": {"logo-mac.png": 2048, "VisualElements_150.png": (2048, 2048),
                 "VisualElements_70.png": (512, 512)},
}
APP_ICO_SIZES = [256, 64, 48, 32, 16]           # firefox.ico, firefox64.ico
DOC_ICO_SIZES = [16, 32, 48, 64, 128, 256]       # document*.ico, pbmode.ico
SMALL_MAX = 32  # sizes <= this use the simplified mark (no star / sky dots)


@dataclass(frozen=True)
class Outline:
  d: str
  bounds: tuple  # (xmin, ymin, xmax, ymax) in font units, baseline at y=0


# Outfit SemiBold/ExtraBold glyph outlines, font units (1000 upm), y down.
GLYPHS = {
    'Nightly': Outline(
        d=(
            'M71.8 0V-703H166.8L208 -566.5V0ZM558 0 140.5 -540 166.8 -703 584.2 -163ZM558 0 519.2 -131.8V-703'
            'H655.5V0ZM785 0V-483H916.5V0ZM850.8 -560.5Q819 -560.5 798 -582.1Q777 -603.8 777 -635.5Q777 -667.'
            '2 798 -688.9Q819 -710.5 850.8 -710.5Q883.5 -710.5 904 -688.9Q924.5 -667.2 924.5 -635.5Q924.5 -60'
            '3.8 904 -582.1Q883.5 -560.5 850.8 -560.5ZM1235.2 214Q1157.5 214 1098.8 186.5Q1040 159 1005 109L1'
            '088 26.2Q1115.5 59.5 1150.2 76.6Q1185 93.8 1234 93.8Q1294.8 93.8 1330.1 62.9Q1365.5 32 1365.5 -2'
            '2.5V-143.5L1387.8 -249.5L1366.8 -356V-483H1497V-24.5Q1497 47.5 1463.5 100.9Q1430 154.2 1371 184.'
            '1Q1312 214 1235.2 214ZM1229.2 -12.5Q1164 -12.5 1112.1 -44.1Q1060.2 -75.8 1030.6 -130.8Q1001 -185'
            '.8 1001 -253.5Q1001 -321.5 1030.6 -375.6Q1060.2 -429.8 1112.1 -461.4Q1164 -493 1229.2 -493Q1282.'
            '8 -493 1324.1 -472.1Q1365.5 -451.2 1389.6 -414.4Q1413.8 -377.5 1415.5 -328.5V-177Q1413.8 -128.8 '
            '1389.2 -91.5Q1364.8 -54.2 1323.4 -33.4Q1282 -12.5 1229.2 -12.5ZM1254.8 -132.2Q1290.8 -132.2 1317'
            '.5 -147.8Q1344.2 -163.2 1358.9 -190.4Q1373.5 -217.5 1373.5 -253Q1373.5 -288.5 1358.9 -315.6Q1344'
            '.2 -342.8 1317.6 -358.2Q1291 -373.8 1255 -373.8Q1219.2 -373.8 1192.1 -358.2Q1165 -342.8 1150 -31'
            '5.5Q1135 -288.2 1135 -253Q1135 -218.8 1150 -191.1Q1165 -163.5 1192 -147.9Q1219 -132.2 1254.8 -13'
            '2.2ZM1936.5 0V-276.8Q1936.5 -320 1909.5 -347.1Q1882.5 -374.2 1840.4 -374.2Q1811.8 -374.2 1789.8 '
            '-362Q1767.8 -349.8 1755.4 -327.6Q1743 -305.5 1743 -276.8L1691.8 -303.2Q1691.8 -359.5 1715.9 -402'
            '.1Q1740 -444.8 1782.7 -468.9Q1825.3 -493 1880 -493Q1935.2 -493 1977.8 -469.1Q2020.2 -445.2 2044.'
            '1 -403.2Q2068 -361.2 2068 -306V0ZM1611.5 0V-723H1743V0ZM2244.5 0V-683.5H2376V0ZM2132 -368V-483H2'
            '488.5V-368ZM2562.5 0V-723H2694V0ZM2961.8 3.8 2759.5 -483H2902.2L3035.8 -111.2H2988L3127 -483H327'
            '0.2L3054.8 3.8ZM2827.8 202.5 2975.2 -108.5 3054.8 3.8 2967.2 202.5Z'
        ),
        bounds=(71.75, -723.0, 3270.25, 214.0),
    ),
    'Beta': Outline(
        d=(
            'M171.5 0V-111H355Q404.2 -111 431.8 -140.9Q459.2 -170.8 459.2 -212Q459.2 -239.8 446.9 -262.9Q434.'
            '5 -286 411.1 -299.5Q387.8 -313 355 -313H171.5V-422.5H340Q381.8 -422.5 407.2 -443.8Q432.8 -465 43'
            '2.8 -507.2Q432.8 -549.5 407.2 -570.8Q381.8 -592 340 -592H171.5V-703H356.2Q425.8 -703 473.1 -677.'
            '4Q520.5 -651.8 544.5 -610.4Q568.5 -569 568.5 -520Q568.5 -459.8 532.1 -416.2Q495.8 -372.8 425.5 -'
            '351.5L431.8 -395.8Q509.5 -373.8 552.2 -323.2Q595 -272.8 595 -201.8Q595 -145.8 567.4 -100.1Q539.8'
            ' -54.5 487.2 -27.2Q434.8 0 360 0ZM71.8 0V-703H207V0ZM919.8 10.5Q844.2 10.5 784.9 -22Q725.5 -54.5'
            ' 691.2 -111.9Q657 -169.2 657 -241.5Q657 -313.5 690.6 -370.4Q724.2 -427.2 782.1 -460.4Q840 -493.5'
            ' 911.2 -493.5Q980.8 -493.5 1034.1 -462.4Q1087.5 -431.2 1118 -376.8Q1148.5 -322.2 1148.5 -252.5Q1'
            '148.5 -239.8 1147 -226.2Q1145.5 -212.8 1142 -196L735.5 -195.2V-292.8L1081 -293.5L1027.5 -253.2Q1'
            '026 -296.2 1012.4 -325.1Q998.8 -354 973.4 -369.2Q948 -384.5 910.8 -384.5Q871.8 -384.5 843 -367.2'
            'Q814.2 -350 798.6 -318.6Q783 -287.2 783 -243.5Q783 -199.5 799.6 -167.1Q816.2 -134.8 847 -117.4Q8'
            '77.8 -100 919 -100Q955.5 -100 985.8 -112.6Q1016 -125.2 1038 -150.2L1115 -72.8Q1079.5 -31.5 1029 '
            '-10.5Q978.5 10.5 919.8 10.5ZM1300.5 0V-683.5H1432V0ZM1188 -368V-483H1544.5V-368ZM1820.5 10Q1754.'
            '5 10 1701.9 -23Q1649.2 -56 1618.9 -112.8Q1588.5 -169.5 1588.5 -240.8Q1588.5 -312.8 1618.9 -369.6'
            'Q1649.2 -426.5 1701.9 -459.8Q1754.5 -493 1820.5 -493Q1872.5 -493 1913.5 -471.8Q1954.5 -450.5 197'
            '9.4 -413.2Q2004.2 -376 2006 -328.5V-154.5Q2004.2 -107 1979.8 -69.8Q1955.2 -32.5 1913.9 -11.2Q187'
            '2.5 10 1820.5 10ZM1845 -111Q1900 -111 1933.8 -147.6Q1967.5 -184.2 1967.5 -241.5Q1967.5 -280 1952'
            '.2 -309.4Q1937 -338.8 1909.5 -355.4Q1882 -372 1845.2 -372Q1809.2 -372 1781.8 -355.4Q1754.2 -338.'
            '8 1738.4 -309.2Q1722.5 -279.8 1722.5 -241.5Q1722.5 -203.2 1738.2 -173.8Q1754 -144.2 1781.6 -127.'
            '6Q1809.2 -111 1845 -111ZM1960.8 0V-129.8L1981.8 -247.5L1960.8 -364.2V-483H2091V0Z'
        ),
        bounds=(71.75, -703.0, 2091, 10.5),
    ),
    'PDF': Outline(
        d=(
            'M204.5 -253.5V-386.5H345Q371.1 -386.5 392.7 -397.2Q414.3 -407.9 427.3 -429.1Q440.2 -450.4 440.2 '
            '-481.2Q440.2 -512.1 427.3 -533.4Q414.3 -554.6 392.7 -565.3Q371.1 -576 345 -576H204.5V-709H375.8Q'
            '444 -709 498.8 -681.6Q553.5 -654.2 585.5 -603.4Q617.5 -552.6 617.5 -481.3Q617.5 -410.8 585.5 -35'
            '9.5Q553.5 -308.2 498.8 -280.9Q444 -253.5 375.8 -253.5ZM63.2 0V-709H242V0ZM823.5 0V-153.8H994Q105'
            '4 -153.8 1098.4 -176.9Q1142.8 -200 1166.9 -245.4Q1191 -290.8 1191 -355.5Q1191 -420 1166.4 -464.5'
            'Q1141.8 -509 1097.8 -532.1Q1053.8 -555.2 994 -555.2H816V-709H994.8Q1076.8 -709 1145.9 -683.6Q121'
            '5 -658.2 1266.1 -611.1Q1317.2 -564 1345.4 -499Q1373.5 -434 1373.5 -354.5Q1373.5 -275.2 1345.4 -2'
            '10.1Q1317.2 -145 1266.2 -97.9Q1215.2 -50.8 1146.5 -25.4Q1077.8 0 996.8 0ZM703.2 0V-709H882V0ZM14'
            '64.2 0V-709H1643V0ZM1605.5 -264.8V-415.5H1957V-264.8ZM1605.5 -558.2V-709H1972.5V-558.2Z'
        ),
        bounds=(63.25, -709.0, 1972.5, 0.0),
    ),
}
WORD_GAP = 260  # font units between "Nightly" and the suffix word


# ---------------------------------------------------------------- geometry --

def _fmt(v, digits=2):
  return (f"%.{digits}f" % v).rstrip("0").rstrip(".")


def _scale(v):
  return _fmt(v, 6)


def sparkle_path(cx, cy, r, waist):
  """Four-point star with concave sides (quadratic curves through the waist)."""
  f = _fmt
  pts = [(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)]
  d = f"M{f(pts[0][0])} {f(pts[0][1])}"
  for i in range(4):
    nx, ny = pts[(i + 1) % 4]
    d += f"Q{f(cx + (waist if i in (0, 1) else -waist))} {f(cy + (waist if i in (1, 2) else -waist))} {f(nx)} {f(ny)}"
  return d + "Z"


def _defs(pal, uid):
  return (
      f'<linearGradient id="{uid}t" x1="0" y1="0" x2="0" y2="1">'
      f'<stop offset="0" stop-color="{pal.tile_top}"/>'
      f'<stop offset="1" stop-color="{pal.tile_bottom}"/></linearGradient>'
      f'<radialGradient id="{uid}g" cx="0.46" cy="0.54" r="0.5">'
      f'<stop offset="0" stop-color="{pal.glow}" stop-opacity="0.32"/>'
      f'<stop offset="1" stop-color="{pal.glow}" stop-opacity="0"/></radialGradient>'
      f'<linearGradient id="{uid}m" x1="0.15" y1="0.1" x2="0.85" y2="0.95">'
      f'<stop offset="0" stop-color="{pal.moon_light}"/>'
      f'<stop offset="1" stop-color="{pal.moon_dark}"/></linearGradient>')


def tile_elements(pal, uid, small=False, x=0, y=0, size=1024, sky=True):
  """Place the complete owner artwork without stretching or cropping."""
  return (f'<image x="{_fmt(x)}" y="{_fmt(y)}" width="{_fmt(size)}" '
          f'height="{_fmt(size)}" preserveAspectRatio="xMidYMid meet" '
          f'href="{ARTWORK_URI}"/>')


def svg_doc(w, h, body, defs="", view=None):
  vb = view or f"0 0 {_fmt(w)} {_fmt(h)}"
  return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{_fmt(w)}" height="{_fmt(h)}" '
          f'viewBox="{vb}" fill="none"><defs>{defs}</defs>{body}</svg>\n')


def app_icon_svg(pal, small=False):
  return svg_doc(1024, 1024, tile_elements(pal, "n", small), _defs(pal, "n"))


def mac_icon_svg(pal, small=False):
  # macOS icon grid: 824px artwork centred in a transparent 1024px canvas.
  return svg_doc(1024, 1024, tile_elements(pal, "n", small, 100, 100, 824))


def private_svg(small=False):
  pal = PRIVATE
  uid = "p"
  # closed eye: lid arc + lashes, stroked in the moon gradient
  p0, p1, p2 = (270, 470), (512, 700), (754, 470)
  width = 84 if small else 64
  lashes = []
  for t in ((0.22, 0.5, 0.78) if small else (0.14, 0.38, 0.62, 0.86)):
    bx = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
    by = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
    tx = 2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0])
    ty = 2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1])
    n = math.hypot(tx, ty)
    nx, ny = -ty / n, tx / n  # points downward/outward from the lid
    if ny < 0:
      nx, ny = -nx, -ny
    length = 120 if small else 104
    lashes.append(f'M{_fmt(bx)} {_fmt(by)}L{_fmt(bx + nx * length)} {_fmt(by + ny * length)}')
  stroke = (f'stroke="url(#{uid}m)" stroke-width="{width}" stroke-linecap="round" '
            f'stroke-linejoin="round" fill="none"')
  # gradient on strokes uses objectBoundingBox of the path; give it userSpace
  defs = _defs(pal, uid).replace(
      f'<linearGradient id="{uid}m" x1="0.15" y1="0.1" x2="0.85" y2="0.95">',
      f'<linearGradient id="{uid}m" gradientUnits="userSpaceOnUse" x1="250" y1="300" x2="780" y2="820">')
  rx = _fmt(1024 * (0.2 if small else 0.225))
  body = (f'<rect width="1024" height="1024" rx="{rx}" fill="url(#{uid}t)"/>'
          f'<rect width="1024" height="1024" rx="{rx}" fill="url(#{uid}g)"/>'
          f'<path {stroke} d="M{p0[0]} {p0[1]}Q{p1[0]} {p1[1]} {p2[0]} {p2[1]}{"".join(lashes)}"/>')
  if not small:
    body += f'<path fill="url(#{uid}m)" d="{sparkle_path(760, 250, 70, 13)}"/>'
  return svg_doc(1024, 1024, body, defs)


def _word_group(words, x, y, height, fill):
  """Place outline words with cap height `height` at baseline (x, y)."""
  scale = height / 700.0
  out, cursor = [], 0.0
  for i, word in enumerate(words):
    g = GLYPHS[word]
    if i:
      cursor += WORD_GAP
    out.append(f'<path transform="translate({_fmt(cursor - g.bounds[0])} 0)" d="{g.d}"/>')
    cursor += g.bounds[2] - g.bounds[0]
  return (f'<g fill="{fill}" transform="translate({_fmt(x)} {_fmt(y)}) scale({_scale(scale)})">'
          + "".join(out) + "</g>"), cursor * scale


def _words(pal):
  return ["Nightly"] + ([pal.wordmark_suffix] if pal.wordmark_suffix else [])


def wordmark_svg(pal, fill):
  # 56 units tall like the Firefox/Zen wordmarks; cap height 34, descender room.
  words = _words(pal)
  _, width = _word_group(words, 0, 0, 34, fill)
  w = math.ceil(width + 4)
  body, _ = _word_group(words, 2, 43, 34, fill)
  return svg_doc(w, 56, body)


def document_svg(pal, pdf=False):
  page = ('<path d="M52 14H164L216 66V232C216 238 212 242 206 242H52C46 242 42 238 42 232V24'
          'C42 18 46 14 52 14Z" fill="#FFFFFF" stroke="#B9BDCB" stroke-width="5"/>'
          '<path d="M164 14V58C164 62 168 66 172 66H216" fill="#E6E8EF" stroke="#B9BDCB" '
          'stroke-width="5" stroke-linejoin="round"/>')
  mark = f'<g opacity="{0.45 if pdf else 1}">{tile_elements(pal, "n", False, 76, 92, 104, False)}</g>'
  body = page + mark
  if pdf:
    _, lw = _word_group(["PDF"], 0, 0, 44, "#FFFFFF")
    body += ('<rect x="20" y="160" width="216" height="72" rx="10" fill="#E5252A"/>'
             + _word_group(["PDF"], 128 - lw / 2, 218, 44, "#FFFFFF")[0])
  return svg_doc(256, 256, body, _defs(pal, "n"))


def watermark_svg(pal):
  # NSIS welcome/finish side image: 164 x 314 sky with mark and wordmark.
  uid = "w"
  sky = [(22, 30, 1.6), (60, 18, 1.1), (138, 44, 1.4), (118, 190, 1.1), (28, 210, 1.3),
         (150, 250, 1.0), (40, 140, 0.9), (96, 228, 0.9)]
  words = _words(pal)
  _, ww = _word_group(words, 0, 0, 22, "#FFFFFF")
  if ww > 140:
    cap = 22 * 140 / ww
  else:
    cap = 22
  _, ww = _word_group(words, 0, 0, cap, "#FFFFFF")
  text, _ = _word_group(words, (164 - ww) / 2, 286, cap, "#FFFFFF")
  body = (f'<rect width="164" height="314" fill="url(#{uid}t)"/>'
          f'<rect width="164" height="314" fill="url(#{uid}g)"/>'
          + "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#FFFFFF" fill-opacity="0.6"/>'
                    for x, y, r in sky)
          + tile_elements(pal, uid, False, 14, 46, 136)
          + text)
  defs = _defs(pal, uid).replace('cx="0.46" cy="0.54" r="0.5"', 'cx="0.5" cy="0.38" r="0.6"')
  return svg_doc(164, 314, body, defs)


def installer_svg(pal):
  # 320 x 130 banner (kept at the size of the file it replaces).
  words = _words(pal)
  _, ww = _word_group(words, 0, 0, 30, "#FFFFFF")
  cap = 30 if ww <= 170 else 30 * 170 / ww
  text, _ = _word_group(words, 128, 80, cap, "#FFFFFF")
  body = ('<rect width="320" height="130" rx="18" fill="url(#bt)"/>'
          '<rect width="320" height="130" rx="18" fill="url(#bg)"/>'
          + tile_elements(pal, "b", False, 24, 17, 96, False) + text)
  return svg_doc(320, 130, body, _defs(pal, "b"))


def docs_wordmark_svg(fill):
  # Horizontal lockup for the README: icon + "Nightly Browser"-style wordmark.
  pal = PALETTES["release"]
  text, ww = _word_group(["Nightly"], 76, 46, 34, fill)
  w = math.ceil(76 + ww + 4)
  body = tile_elements(pal, "d", False, 0, 0, 64, False) + text
  return svg_doc(w, 64, body, _defs(pal, "d"))


# --------------------------------------------------------------- rendering --

def render(svg, w, h=None):
  """Rasterize to RGBA. h=None renders a w x w square; w=None keeps aspect at height h."""
  if w is None:
    png = resvg_py.svg_to_bytes(svg_string=svg, height=h, skip_system_fonts=True)
  else:
    png = resvg_py.svg_to_bytes(svg_string=svg, width=w, height=h or w, skip_system_fonts=True)
  return Image.open(io.BytesIO(bytes(png))).convert("RGBA")


def on_canvas(img, w, h):
  canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
  canvas.alpha_composite(img, ((w - img.width) // 2, (h - img.height) // 2))
  return canvas


def write_ico(path, images):
  """ICO with 32-bit BMP entries, except 256px which is PNG (as Windows expects)."""
  blobs = []
  for img in images:
    w, h = img.size
    if w >= 256:
      buf = io.BytesIO()
      img.save(buf, "PNG", optimize=True)
      blobs.append(buf.getvalue())
      continue
    flipped = img.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    xor = flipped.tobytes("raw", "BGRA")
    row = ((w + 31) // 32) * 4
    mask = bytearray(row * h)
    alpha = flipped.getchannel("A").tobytes()
    for yy in range(h):
      for xx in range(w):
        if alpha[yy * w + xx] == 0:
          mask[yy * row + xx // 8] |= 0x80 >> (xx % 8)
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0)
    blobs.append(header + xor + bytes(mask))
  out = struct.pack("<HHH", 0, 1, len(images))
  offset = 6 + 16 * len(images)
  for img, blob in zip(images, blobs):
    w, h = img.size
    out += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
  with open(path, "wb") as f:
    f.write(out + b"".join(blobs))


def write_icns(path, mac_svg, mac_svg_small):
  sizes = {16: "16x16", 32: "32x32", 128: "128x128", 256: "256x256", 512: "512x512"}
  if shutil.which("iconutil"):
    with tempfile.TemporaryDirectory() as tmp:
      iconset = os.path.join(tmp, "nightly.iconset")
      os.mkdir(iconset)
      for base, name in sizes.items():
        for scale, suffix in ((1, ""), (2, "@2x")):
          px = base * scale
          svg = mac_svg_small if px <= SMALL_MAX else mac_svg
          render(svg, px).save(os.path.join(iconset, f"icon_{name}{suffix}.png"))
      subprocess.run(["iconutil", "-c", "icns", iconset, "-o", path], check=True)
  else:
    big = render(mac_svg, 1024)
    big.save(path, "ICNS", append_images=[render(mac_svg, s) for s in (16, 32, 64, 128, 256, 512)])


def save_png(img, path):
  img.save(path, "PNG", optimize=True)


def write_text(path, text):
  with open(path, "w", encoding="utf-8", newline="\n") as f:
    f.write(text)


def build_brand(brand, pal):
  out = os.path.join(BRANDING, brand)
  content = os.path.join(out, "content")
  os.makedirs(content, exist_ok=True)
  icon, icon_small = app_icon_svg(pal), app_icon_svg(pal, small=True)
  mac, mac_small = mac_icon_svg(pal), mac_icon_svg(pal, small=True)
  priv, priv_small = private_svg(), private_svg(small=True)

  def icon_png(px, small_svg=icon_small, big_svg=icon):
    return render(small_svg if px <= SMALL_MAX else big_svg, px)

  for name, px in COMMON_SIZES.items():
    save_png(icon_png(px), os.path.join(out, name))
  sizes = BRAND_SIZES[brand]
  save_png(render(mac, sizes["logo-mac.png"]), os.path.join(out, "logo-mac.png"))
  write_icns(os.path.join(out, "firefox.icns"), mac, mac_small)
  write_icns(os.path.join(out, "document.icns"), document_svg(pal), document_svg(pal))
  disk = svg_doc(1024, 1024,
      '<rect x="120" y="160" width="784" height="744" rx="80" fill="#B9BDCB"/>'
      '<rect x="176" y="826" width="672" height="16" rx="8" fill="#454854"/>'
      + tile_elements(pal, "disk", x=160, y=120, size=704))
  write_icns(os.path.join(out, "disk.icns"), disk, disk)

  app_ico = [icon_png(px) for px in APP_ICO_SIZES]
  write_ico(os.path.join(out, "firefox.ico"), app_ico)
  write_ico(os.path.join(out, "firefox64.ico"), app_ico)
  doc, pdf = document_svg(pal), document_svg(pal, pdf=True)
  write_ico(os.path.join(out, "document.ico"), [render(doc, px) for px in DOC_ICO_SIZES])
  write_ico(os.path.join(out, "document_pdf.ico"), [render(pdf, px) for px in DOC_ICO_SIZES])
  write_ico(os.path.join(out, "pbmode.ico"),
            [icon_png(px, priv_small, priv) for px in DOC_ICO_SIZES])

  for name in ("VisualElements_150.png", "VisualElements_70.png"):
    w, h = sizes[name]
    inner = round(min(w, h) * 0.957)
    save_png(on_canvas(render(icon, inner), w, h), os.path.join(out, name))
  msix = os.path.join(out, "msix", "Assets")
  os.makedirs(msix, exist_ok=True)
  for name, w, h in (
      ("StoreLogo.scale-200", 100, 100), ("LargeTile.scale-200", 620, 620),
      ("SmallTile.scale-200", 142, 142), ("Wide310x150Logo.scale-200", 620, 300),
      ("Square150x150Logo.scale-200", 300, 300), ("MedTile.scale-200", 300, 300),
      ("Square44x44Logo.scale-200", 88, 88), ("Square44x44Logo.targetsize-256", 256, 256),
      ("Square44x44Logo.altform-unplated_targetsize-256", 256, 256),
      ("Square44x44Logo.altform-lightunplated_targetsize-256", 256, 256)):
    save_png(on_canvas(icon_png(round(min(w, h) * 0.8)), w, h),
             os.path.join(msix, name + ".png"))
  save_png(render(doc, 44), os.path.join(msix, "Document44x44.png"))
  for name, px, inner in (("PrivateBrowsing_150.png", 270, 258), ("PrivateBrowsing_70.png", 126, 120)):
    save_png(on_canvas(render(priv, inner), px, px), os.path.join(out, name))

  wm = render(watermark_svg(pal), 164, 314)
  wm.convert("RGB").convert("RGBA").save(os.path.join(out, "wizWatermark.bmp"), "BMP")
  write_text(os.path.join(out, "MacOSInstaller.svg"), installer_svg(pal))
  for name, x in (("wizHeader.bmp", 93), ("wizHeaderRTL.bmp", 0)):
    header = Image.new("RGBA", (150, 57), "white")
    header.alpha_composite(icon_png(49), (x + 4, 4))
    header.convert("RGB").save(os.path.join(out, name), "BMP")
  about = svg_doc(300, 236, '<rect width="300" height="236" fill="#14152B"/>'
                  + tile_elements(pal, "about", x=74, y=12, size=152)
                  + _word_group(["Nightly"], 76, 209, 30, "#FFFFFF")[0])
  save_png(render(about, 300, 236), os.path.join(content, "about.png"))

  write_text(os.path.join(content, "about-logo.svg"), icon)
  write_text(os.path.join(content, "document_pdf.svg"), pdf)
  save_png(on_canvas(render(icon, 480), 512, 512), os.path.join(content, "about-logo.png"))
  save_png(on_canvas(render(icon, 960), 1024, 1024), os.path.join(content, "about-logo@2x.png"))
  write_text(os.path.join(content, "about-logo-private.svg"), priv)
  save_png(on_canvas(render(priv, 184), 192, 192), os.path.join(content, "about-logo-private.png"))
  save_png(on_canvas(render(priv, 368), 384, 384), os.path.join(content, "about-logo-private@2x.png"))
  write_text(os.path.join(content, "about-wordmark.svg"),
             wordmark_svg(pal, "context-fill #20123a"))
  write_text(os.path.join(content, "firefox-wordmark.svg"), wordmark_svg(pal, "#fff"))


def build_shared():
  icon = app_icon_svg(PALETTES["release"])
  write_text(os.path.join(BRANDING, "nightly-logo.svg"), icon)
  os.makedirs(os.path.dirname(FLATPAK_ICON), exist_ok=True)
  write_text(FLATPAK_ICON, icon)
  os.makedirs(DOCS_ASSETS, exist_ok=True)
  write_text(os.path.join(DOCS_ASSETS, "nightly-wordmark-dark.svg"), docs_wordmark_svg("#14152B"))
  write_text(os.path.join(DOCS_ASSETS, "nightly-wordmark-light.svg"), docs_wordmark_svg("#FFFFFF"))


def preview(path):
  """Contact sheet: every brand's key assets at a glance, incl. tiny sizes."""
  rows = []
  for brand in PALETTES:
    d = os.path.join(BRANDING, brand)
    files = ["logo1024.png", "logo-mac.png", "PrivateBrowsing_150.png", "VisualElements_150.png",
             "content/about-logo.png", "wizWatermark.bmp"]
    tiles = [Image.open(os.path.join(d, f)).convert("RGBA") for f in files]
    for ico in ("document.ico", "document_pdf.ico", "pbmode.ico"):
      tiles.append(Image.open(os.path.join(d, ico)).convert("RGBA"))
    rows.append((brand, d, tiles))
  cell, pad = 180, 10
  sheet = Image.new("RGBA", (pad + (cell + pad) * 10, pad + (cell + pad) * 4), (120, 124, 136, 255))
  for r, (brand, d, tiles) in enumerate(rows):
    for c, t in enumerate(tiles):
      t = t.copy()
      t.thumbnail((cell, cell), Image.LANCZOS)
      sheet.alpha_composite(t, (pad + c * (cell + pad), pad + r * (cell + pad)))
    x = pad
    for px in (16, 22, 24, 32, 48, 64):
      im = Image.open(os.path.join(d, f"logo{px}.png")).convert("RGBA")
      sheet.alpha_composite(im, (x, pad + (2 + r) * (cell + pad)))
      big = im.resize((px * 3, px * 3), Image.NEAREST)
      sheet.alpha_composite(big, (x, pad + (2 + r) * (cell + pad) + 70))
      x += px * 3 + 16
    wm = render(open(os.path.join(d, "content", "firefox-wordmark.svg")).read(), None, 86)
    sheet.alpha_composite(wm, (x + 20, pad + (2 + r) * (cell + pad) + 40))
  sheet.save(path)


def main():
  parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
  parser.add_argument("--preview", help="also write a contact sheet PNG to this path")
  args = parser.parse_args()
  for brand, pal in PALETTES.items():
    build_brand(brand, pal)
  build_shared()
  if args.preview:
    preview(args.preview)
    print(f"preview: {args.preview}")


if __name__ == "__main__":
  main()
