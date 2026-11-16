"""
REV-106. Writes the icons that Kentō shows on a pull request: public/assets/pr/<name>.v<N>.svg and
<name>-dark.v<N>.svg, with the colours of public/assets/kento.css.

GitHub shows each icon as an image (camo), and an image loads no web font: the script draws the
text of a badge as paths, from the Archivo font of the app.

Run from apps/web, with fontTools and brotli (`pip install fonttools brotli`):

    python3 scripts/pr-icons.py

GitHub keeps an image in its cache under its URL. If you change an icon, increase VERSION, then
change ICON_VERSION in packages/engine/src/render.ts to the same value.
"""

from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

VERSION = 2
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public/assets/pr'
FONT = ROOT / 'public/assets/fonts/archivo-latin-wght-normal.woff2'

# The tokens of kento.css, Papier then Sumi. `gauge-empty` is `--line`, and `--line-strong` in Sumi:
# `--line` is too dark on the dark background of GitHub.
TOKENS = {
    'light': {
        'ink': '#1b1a18', 'ink-muted': '#5c5953', 'line': '#dad7cf', 'line-strong': '#8e8a82',
        'paper-raised': '#ffffff', 'paper-sunken': '#eae8e2',
        'shu': '#b8321a', 'shu-wash': '#f8e3dd', 'on-shu': '#ffffff',
        'ai': '#2b5592', 'ai-wash': '#e3eaf6',
        'matsu': '#2d6a47', 'matsu-wash': '#e1f0e6',
        'kuchiba': '#8a5a0b', 'kuchiba-wash': '#f5ead6', 'kuchiba-mark': '#b07a1a',
        'nezumi': '#75716a', 'gauge-empty': '#dad7cf',
    },
    'dark': {
        'ink': '#edebe6', 'ink-muted': '#a9a59d', 'line': '#33302c', 'line-strong': '#6e6a63',
        'paper-raised': '#1e1c1a', 'paper-sunken': '#0f0e0d',
        'shu': '#f0553a', 'shu-wash': '#3a1710', 'on-shu': '#151413',
        'ai': '#8db0ee', 'ai-wash': '#17233a',
        'matsu': '#6fc796', 'matsu-wash': '#13281c',
        'kuchiba': '#e0ae52', 'kuchiba-wash': '#2e2310', 'kuchiba-mark': '#b9852c',
        'nezumi': '#8d8981', 'gauge-empty': '#6e6a63',
    },
}

HEIGHT = 20
# The gauge sits next to the h2 of the block: its image takes the height of a line of that title.
GAUGE_HEIGHT = 26
RADIUS = 4
FONT_SIZE = 12
PAD = 7

font = TTFont(FONT)
instantiateVariableFont(font, {'wght': 600}, inplace=True)
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
UPM = font['head'].unitsPerEm
CAP = font['OS/2'].sCapHeight


def text_path(text: str, x: float, size: float = FONT_SIZE) -> tuple[str, float]:
    """The path of `text` from `x`, centred on the cap height in the badge, and its width."""
    scale = size / UPM
    baseline = HEIGHT / 2 + CAP * scale / 2
    pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}'.rstrip('0').rstrip('.'))
    advance = 0.0
    for char in text:
        name = cmap[ord(char)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x + advance, baseline)))
        advance += glyphs[name].width * scale
    return pen.getCommands(), advance


def text_width(text: str) -> float:
    return sum(glyphs[cmap[ord(c)]].width for c in text) * FONT_SIZE / UPM


def svg(width: float, height: int, body: str, title: str) -> str:
    w = f'{width:g}'
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{height}" viewBox="0 0 {w} {height}" role="img" aria-label="{title}">'
        f'<title>{title}</title>{body}</svg>\n'
    )


# A small warning triangle, 10 px wide, for the badge "to check".
def triangle(x: float, fill: str, mark: str) -> str:
    return (
        f'<path d="M{x + 5} 5.2 L{x + 10} 14.6 H{x} Z" fill="{fill}" stroke="{fill}" stroke-width="1.2" stroke-linejoin="round"/>'
        f'<path d="M{x + 5} 8.4 V11.2" stroke="{mark}" stroke-width="1.4" stroke-linecap="round"/>'
        f'<circle cx="{x + 5}" cy="13" r=".8" fill="{mark}"/>'
    )


def badge(label: str, t: dict, fill: str, text: str, border: str | None = None, dashed: bool = False, warn: bool = False) -> str:
    lead = 14 if warn else 0
    width = round(PAD * 2 + lead + text_width(label))
    path, _ = text_path(label, PAD + lead)
    stroke = f' stroke="{border}" stroke-width="1"' + (' stroke-dasharray="3 2"' if dashed else '') if border else ''
    body = f'<rect x=".5" y=".5" width="{width - 1}" height="{HEIGHT - 1}" rx="{RADIUS}" fill="{fill}"{stroke}/>'
    if warn:
        body += triangle(PAD, t['kuchiba-mark'], t['kuchiba-wash'])
    body += f'<path d="{path}" fill="{text}"/>'
    return svg(width, HEIGHT, body, label)


BADGES = {
    'p0': lambda t: badge('P0', t, t['shu'], t['on-shu']),
    'p1': lambda t: badge('P1', t, t['shu-wash'], t['shu'], border=t['shu']),
    'p2': lambda t: badge('P2', t, t['paper-sunken'], t['ink-muted'], border=t['line-strong']),
    'security': lambda t: badge('security', t, t['ai-wash'], t['ai'], border=t['ai']),
    'to-check': lambda t: badge('to check', t, t['kuchiba-wash'], t['kuchiba'], border=t['kuchiba-mark'], warn=True),
    'to-consider': lambda t: badge('to consider', t, t['paper-raised'], t['nezumi'], border=t['nezumi'], dashed=True),
}

SYMBOLS = {
    'blocking': (
        'Blocking',
        lambda t: f'<circle cx="10" cy="10" r="8" fill="{t["shu"]}"/><path d="M5.5 10 H14.5" stroke="{t["on-shu"]}" stroke-width="2.4" stroke-linecap="round"/>',
    ),
    'warning': (
        'To check',
        lambda t: f'<path d="M10 2.6 L18 16.8 H2 Z" fill="{t["kuchiba-mark"]}" stroke="{t["kuchiba-mark"]}" stroke-width="1.6" stroke-linejoin="round"/>'
        f'<path d="M10 7.4 V11.6" stroke="{t["kuchiba-wash"]}" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.2" r="1.1" fill="{t["kuchiba-wash"]}"/>',
    ),
    'ok': (
        'Nothing blocking',
        lambda t: f'<circle cx="10" cy="10" r="8" fill="{t["matsu"]}"/><path d="M6 10.2 L8.8 13 L14 7.4" fill="none" stroke="{t["matsu-wash"]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    ),
    'thread': (
        'Thread',
        lambda t: f'<rect x="2.5" y="2.5" width="15" height="15" rx="{RADIUS}" fill="{t["ai-wash"]}" stroke="{t["ai"]}"/><path d="M7.4 6.6 L12.6 10 L7.4 13.4 Z" fill="{t["ai"]}" stroke="{t["ai"]}" stroke-linejoin="round"/>',
    ),
    'resolved': (
        'Resolved',
        lambda t: f'<rect x="2" y="2" width="16" height="16" rx="{RADIUS}" fill="{t["matsu"]}"/><path d="M6 10.2 L8.8 13 L14 7.4" fill="none" stroke="{t["matsu-wash"]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    ),
    'to-resolve': (
        'To resolve',
        lambda t: f'<rect x="2.5" y="2.5" width="15" height="15" rx="{RADIUS}" fill="{t["matsu-wash"]}" stroke="{t["matsu"]}"/><path d="M6 10.2 L8.8 13 L14 7.4" fill="none" stroke="{t["matsu"]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    ),
    'stays-open': (
        'Stays open',
        lambda t: f'<path d="M4.5 3.5 H15.5 A2 2 0 0 1 17.5 5.5 V12 A2 2 0 0 1 15.5 14 H9 L5.5 17 V14 H4.5 A2 2 0 0 1 2.5 12 V5.5 A2 2 0 0 1 4.5 3.5 Z" fill="{t["ai-wash"]}" stroke="{t["ai"]}" stroke-linejoin="round"/>'
        f'<path d="M6 8.75 H14" stroke="{t["ai"]}" stroke-width="1.4" stroke-linecap="round"/>',
    ),
}


def gauge(score: int, t: dict) -> str:
    colour = t['shu'] if score <= 2 else t['kuchiba-mark'] if score == 3 else t['matsu']
    segments = ''
    for i in range(5):
        fill = colour if i < score else t['gauge-empty']
        segments += f'<rect x="{1 + i * 12}" y="6" width="10" height="14" rx="2" fill="{fill}"/>'
    return svg(60, GAUGE_HEIGHT, segments, f'{score}/5')


def write(name: str, theme: str, content: str) -> None:
    suffix = '' if theme == 'light' else '-dark'
    (OUT / f'{name}{suffix}.v{VERSION}.svg').write_text(content)


OUT.mkdir(parents=True, exist_ok=True)
for theme, t in TOKENS.items():
    for name, draw in BADGES.items():
        write(name, theme, draw(t))
    for name, (title, draw) in SYMBOLS.items():
        write(name, theme, svg(20, HEIGHT, draw(t), title))
    for score in range(1, 6):
        write(f'gauge-{score}', theme, gauge(score, t))
