# Writes the final logo files: clean single-path SVGs (transforms baked in) + an index for PNG rendering.
import json, os
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from shapely.geometry.polygon import orient
from build import Logo, shift, INK, ORANGE
OUT = "out"; os.makedirs(OUT, exist_ok=True)
L = Logo()
C, ASC, DESC = L.C, L.asc, 197  # p's descender

def poly_path(geom, dx=0, dy=0):
    d = []
    for g in getattr(geom, "geoms", [geom]):
        if g.is_empty or g.geom_type != "Polygon": continue
        g = orient(g, 1.0)
        for ring in [g.exterior, *g.interiors]:
            cs = list(ring.coords)[:-1]
            d.append("M" + "L".join(f"{x + dx:.1f} {-(y) + dy:.1f}".replace(".0 ", " ").replace(".0L", "L") for x, y in cs) + "Z")
    return "".join(d)

def glyph_path(gname, dx, dy):
    pen = SVGPathPen(L.f.gs, ntos=lambda v: (f"{v:.1f}").rstrip("0").rstrip("."))
    L.f.gs[gname].draw(TransformPen(pen, (1, 0, 0, -1, dx, dy)))
    return pen.getCommands()

def wordmark(ink, accent, pad=0):
    glyphs, inks, accs, width = L.build()
    # glyphs: [(d, x)] from L.build use font paths; redo them with baked transforms
    f = L.f
    names = [g for g, *_ in f.shape("eep")] + [g for g, *_ in f.shape("rac")]
    from shapely.ops import unary_union
    b = unary_union(inks + accs).bounds
    x0, x1 = min(0, b[0]) - pad, max(width, b[2]) + pad
    top, bottom = ASC + pad, -DESC - pad
    W, H = x1 - x0, top - bottom
    dy = top  # y' = top - y
    ink_d = "".join(glyph_path(n, gx - x0, dy) for n, (d, gx) in zip(names, glyphs))
    ink_d += "".join(poly_path(g, -x0, dy) for g in inks)
    acc_d = "".join(poly_path(g, -x0, dy) for g in accs)
    paths = f'<path fill="{ink}" d="{ink_d}"/>' + (f'<path fill="{accent}" d="{acc_d}"/>' if acc_d else "")
    return W, H, paths

def svg(W, H, body, title="KeepTrack"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" width="{W / 10:.1f}" height="{H / 10:.1f}"><title>{title}</title>{body}</svg>'

files = {}
W, H, p = wordmark(INK, ORANGE); files["keeptrack-logo.svg"] = svg(W, H, p)
W, H, p = wordmark("#FFFFFF", ORANGE); files["keeptrack-logo-white.svg"] = svg(W, H, p)
W, H, p = wordmark("#000000", "#000000"); files["keeptrack-logo-black.svg"] = svg(W, H, p)
W, H, p = wordmark("#FFFFFF", "#FFFFFF"); files["keeptrack-logo-white-mono.svg"] = svg(W, H, p)

# KT monogram
def mono(ink, lanes=True, pad=0):
    parts, w = L.icon(lanes=lanes)
    W, H = w + 2 * pad, C + 2 * pad
    d = "".join(poly_path(g, pad, C + pad) for g in parts)
    return W, H, f'<path fill="{ink}" d="{d}"/>'
W, H, p = mono(INK); files["kt-monogram.svg"] = svg(W, H, p, "KeepTrack")
W, H, p = mono("#FFFFFF"); files["kt-monogram-white.svg"] = svg(W, H, p, "KeepTrack")

def tile(fill=0.84, radius=0.2, lanes=True, bg=ORANGE, ink="#FFFFFF", square=False):
    parts, w = L.icon(lanes=lanes)
    side = max(w, C) / fill
    ox, oy = (side - w) / 2, (side - C) / 2 + C
    d = "".join(poly_path(g, ox, oy) for g in parts)
    rx = 0 if square else radius * side
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side:.0f} {side:.0f}" width="512" height="512"><title>KeepTrack</title>'
            f'<rect width="{side:.0f}" height="{side:.0f}" rx="{rx:.0f}" fill="{bg}"/><path fill="{ink}" d="{d}"/></svg>')
files["kt-tile.svg"] = tile()
files["_tile-16.svg"] = tile(fill=0.88, radius=0.18, lanes=False)
files["_tile-32.svg"] = tile(fill=0.84, radius=0.2)
files["_tile-square.svg"] = tile(fill=0.70, square=True)          # iPhone home screen (iOS rounds the corners itself)
files["_tile-maskable.svg"] = tile(fill=0.62, square=True)        # Android adaptive icons crop to a circle/squircle
for name, s in files.items():
    open(f"{OUT}/{name}", "w").write(s)
    print(f"{name:32s} {len(s):6d} bytes")
