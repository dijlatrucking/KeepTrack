# KeepTrack logo builder. "eep" and "rac" come from Archivo (wght 900); K, T and the final k are drawn here.
# Units: font units (1000/em), y up, baseline 0.
import math
from fontkit import Font
from shapely.geometry import Polygon, box, LineString
from shapely.ops import unary_union

V = "archivo-latin-wdth-normal.woff2"  # from: npm pack @fontsource-variable/archivo (package/files/)
INK, ORANGE = "#15171C", "#D4500B"
tan = lambda a: math.tan(math.radians(a))
sin = lambda a: math.sin(math.radians(a))
cos = lambda a: math.cos(math.radians(a))

def band(x0, y0, angle, width, y_lo=-9e3, y_hi=9e3, ext=6000):
    """Straight band along the line through (x0,y0) at `angle`° (from horizontal), `width` square to it, flat ends at y_lo/y_hi."""
    dx, dy, h = cos(angle), sin(angle), width / 2
    nx, ny = -dy, dx
    pts = [(x0 - dx * ext + nx * h, y0 - dy * ext + ny * h), (x0 + dx * ext + nx * h, y0 + dy * ext + ny * h),
           (x0 + dx * ext - nx * h, y0 + dy * ext - ny * h), (x0 - dx * ext - nx * h, y0 - dy * ext - ny * h)]
    return Polygon(pts).intersection(box(-9e4, y_lo, 9e4, y_hi))

DEFAULTS = dict(
    wdth=86, track=-10,
    A=42,            # K arm, K lane and T lane angle
    slot=0.10,       # lane width (square to it), x cap height
    K_nw=0.32, K_aw=0.58, K_crotch=0.22, K_LA=52, K_legw=0.48, K_end=0.85,
    T_in=0.56, T_end=0.86,
    k_A=48, k_nw=0.22, k_arm=0.80,      # k arm: angle, notch at the x-height (x X), weight (x stem)
    c_B=52, c_L=56, c_w=0.80, c_vx=0.44, c_vy=0.55, c_top=1.0, c_cut=0.065,  # check: short/long stroke angles, weight (x stem), bottom point x (x X from stem) and centre height (x weight), tip height (x X), gap (x C)
    gap_Ke=0.10, gap_pT=0.13, gap_Tr=0.09, gap_ck=0.12,  # spacing next to the drawn letters: closest distance, x cap height
)

class Logo:
    def __init__(self, **kw):
        self.p = p = dict(DEFAULTS, **kw)
        self.f = f = Font(V, {"wght": 900, "wdth": p["wdth"]})
        self.C, self.X = f.cap, f.xh
        rec = lambda g: [a[0] for op, a in f.record(g) if a]
        Kp, Tp, kp, lp = rec("K"), rec("T"), rec("k"), rec("l")
        self.SU = Kp[2][0] - Kp[0][0]
        self.SL = lp[2][0] - lp[0][0]
        self.asc = kp[1][1]
        self.Tbar = Tp[3][1] - Tp[2][1]
        self.Tw = Tp[4][0] - Tp[3][0]

    def K_lane(self):
        C, S, p = self.C, self.SU, self.p
        nw, aw = p["K_nw"] * C, p["K_aw"] * C
        return band(S + nw + aw / 2, C, p["A"], p["slot"] * C, -100, p["K_end"] * C)

    def T_lane(self):
        C, S, p = self.C, self.SU, self.p
        sx = (self.Tw - S) / 2
        return band(sx, p["T_in"] * C, p["A"], p["slot"] * C, -100, p["T_end"] * C)

    def K(self, lane=True):
        C, S, p = self.C, self.SU, self.p
        A, t = p["A"], tan(p["A"])
        nw, aw = p["K_nw"] * C, p["K_aw"] * C
        xa1, xa2 = S + nw, S + nw + aw
        yN = C - nw * t
        crotch, LA, legw = p["K_crotch"] * C, p["K_LA"], p["K_legw"] * C
        tl = tan(LA)
        xLL = S + crotch / tl
        xLR = xLL + legw
        ye = (xLR - xa2 + C / t) / (1 / t + 1 / tl)
        xe = xLR - ye / tl
        outline = Polygon([(0, 0), (0, C), (S, C), (S, yN), (xa1, C), (xa2, C), (xe, ye), (xLR, 0), (xLL, 0), (S, crotch), (S, 0)])
        return (outline.difference(self.K_lane()) if lane else outline), max(xa2, xLR)

    def T(self, lane=True):
        C, S, p = self.C, self.SU, self.p
        w = self.Tw
        sx = (w - S) / 2
        outline = unary_union([box(0, C - self.Tbar, w, C), box(sx, 0, sx + S, C)])
        if lane:
            outline = outline.difference(self.T_lane())
        return outline, w

    def k(self):
        """k with its leg drawn as an orange check: the short stroke tucks under the arm, the long stroke rises to the x-height."""
        X, S, p = self.X, self.SL, self.p
        kA, t = p["k_A"], tan(p["k_A"])
        g = p["c_cut"] * self.C
        stem = box(0, 0, S, self.asc)
        x1 = S + p["k_nw"] * X
        x2 = x1 + p["k_arm"] * S / sin(kA)
        arm = Polygon([(x1, X), (x2, X), (S, X - (x2 - S) * t), (S, X - (x1 - S) * t)])
        black = unary_union([stem, arm])
        w = p["c_w"] * S
        cB, cL = p["c_B"], p["c_L"]
        vx, vy = S + p["c_vx"] * X, p["c_vy"] * w
        P1 = (vx - 3000 / tan(cB), vy + 3000)
        P2 = (vx + (X + 400 - vy) / tan(cL), X + 400)
        check = LineString([P1, (vx, vy), P2]).buffer(w / 2, cap_style=2, join_style=2, mitre_limit=20)
        check = check.intersection(box(-9e4, 0, 9e4, X * p["c_top"]))
        # a gap from the arm (cut parallel to its underside) and from the stem
        xo = x2 + g / sin(kA)
        above = Polygon([(xo - 6000 / t, X - 6000), (xo + 6000 / t, X + 6000), (-9e4, X + 6000), (-9e4, X - 6000)])
        check = check.difference(above).difference(box(-9e4, -100, S + g, 9e4))
        check = max(getattr(check, "geoms", [check]), key=lambda q: q.area)
        return black, check, max(check.bounds[2], x2)

    def build(self):
        """Returns (font glyphs [(d, x)], ink polygons, accent polygons, total advance)."""
        from flat import glyph_geom
        f, p, C = self.f, self.p, self.C
        out, inks, acc = [], [], []
        K, kw = self.K()
        inks.append(K)
        placed = K
        def fit(left, right, target):
            # smallest x shift that keeps `right` at least `target` away from `left`
            lo, hi = left.bounds[0] - right.bounds[0], left.bounds[2] - right.bounds[0] + target + 50
            for _ in range(40):
                mid = (lo + hi) / 2
                if left.distance(shift(right, mid)) < target: lo = mid
                else: hi = mid
            return hi
        x = None
        # e e p from the font (its own spacing), placed as a group next to the K
        sh = f.shape("eep")
        grp, gx, glyphs = [], 0, []
        for g, adv, xo, yo in sh:
            grp.append(shift(glyph_geom(f, g), gx + xo)); glyphs.append((f.path(g), gx + xo)); gx += adv + p["track"]
        e1 = grp[0]
        dx = fit(K, e1, p["gap_Ke"] * C)
        out += [(d, gx0 + dx) for d, gx0 in glyphs]
        placed_p = shift(grp[-1], dx)
        T, tw = self.T()
        dxT = fit(placed_p, T, p["gap_pT"] * C)
        inks.append(shift(T, dxT))
        sh2 = f.shape("rac")
        grp2, gx, glyphs2 = [], 0, []
        for g, adv, xo, yo in sh2:
            grp2.append(shift(glyph_geom(f, g), gx + xo)); glyphs2.append((f.path(g), gx + xo)); gx += adv + p["track"]
        dxr = fit(shift(T, dxT), grp2[0], p["gap_Tr"] * C)
        out += [(d, gx0 + dxr) for d, gx0 in glyphs2]
        last_c = shift(grp2[-1], dxr)
        blk, chk, w = self.k()
        dxk = fit(last_c, blk, p["gap_ck"] * C)
        inks.append(shift(blk, dxk)); acc.append(shift(chk, dxk))
        return out, inks, acc, dxk + w

    def icon(self, lanes=True, gap=0.10):
        """KT monogram: the K's arm runs into the T's crossbar (one top bar); each letter keeps its lane.
        Returns ([geometry], width)."""
        C, S, p = self.C, self.SU, self.p
        Kfull, kw = self.K(lane=False)
        Tfull, tw = self.T(lane=False)
        target = gap * C
        # place the T's stem clear of the K's arm and leg (below the crossbar)
        below = box(-9e4, -100, 9e4, C - self.Tbar - 2)  # (just under the crossbar, so its bottom edge isn't counted)
        Tstem = Tfull.intersection(below)
        lo, hi = 0, kw + target + 50
        for _ in range(40):
            mid = (lo + hi) / 2
            if Kfull.intersection(below).distance(shift(Tstem, mid)) < target: lo = mid
            else: hi = mid
        T = shift(Tfull, hi)
        top = T.bounds  # crossbar spans the T's width; join it to the K's arm along the top
        xa1 = S + p["K_nw"] * C
        bridge = box(xa1 + 1, C - self.Tbar, top[0] + 1, C)
        mono = unary_union([Kfull, T, bridge])
        if lanes:
            # each lane only cuts its own letter
            mono = mono.difference(self.K_lane().intersection(box(-9e4, -9e4, T.bounds[0] + (self.Tw - S) / 2 - 1, 9e4)))
            mono = mono.difference(shift(self.T_lane(), hi).intersection(T))
        return [mono], T.bounds[2]

from shapely import affinity
def shift(geom, dx, dy=0): return affinity.translate(geom, dx, dy)

def poly_d(geom):
    geoms = getattr(geom, "geoms", [geom])
    d = []
    for g in geoms:
        if g.is_empty or g.geom_type != "Polygon": continue
        for ring in [g.exterior, *g.interiors]:
            cs = list(ring.coords)[:-1]
            d.append("M" + " L".join(f"{px:.1f} {py:.1f}" for px, py in cs) + "Z")
    return "".join(d)

def wordmark_svg(L, height=120, ink=INK, accent=ORANGE, bg=None, pad=(40, 40)):
    glyphs, inks, accs, width = L.build()
    top, bottom = L.asc, -200   # ascender to just below the p's descender
    b = unary_union(inks + accs).bounds
    minx, maxx = min(0, b[0]) - pad[0], max(width, b[2]) + pad[0]
    top += pad[1]; bottom -= pad[1]
    W, H = maxx - minx, top - bottom
    s = height / H
    body = "".join(f'<path d="{d}" transform="translate({gx:.1f} 0)"/>' for d, gx in glyphs if d)
    body += "".join(f'<path d="{poly_d(g)}"/>' for g in inks)
    acc = "".join(f'<path d="{poly_d(g)}"/>' for g in accs)
    rect = f'<rect x="{minx:.0f}" y="{-top:.0f}" width="{W:.0f}" height="{H:.0f}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{minx:.0f} {-top:.0f} {W:.0f} {H:.0f}" width="{W * s:.1f}" height="{height}">'
            f'{rect}<g transform="scale(1 -1)"><g fill="{ink}">{body}</g><g fill="{accent}">{acc}</g></g></svg>')

def icon_svg(L, size=200, ink=INK, tile=None, radius=0.22, fill=0.64):
    parts, w = L.icon()
    C = L.C
    if tile:
        side = max(w, C) / fill
        ox, oy = (side - w) / 2, (side - C) / 2
        body = "".join(f'<path d="{poly_d(shift(g, ox, oy))}"/>' for g in parts)
        r = radius * side
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side:.0f} {side:.0f}" width="{size}" height="{size}">'
                f'<rect width="{side:.0f}" height="{side:.0f}" rx="{r:.0f}" fill="{tile}"/>'
                f'<g transform="translate(0 {side:.0f}) scale(1 -1)" fill="{ink}">{body}</g></svg>')
    pad = 0.06 * C
    W, H = w + 2 * pad, C + 2 * pad
    body = "".join(f'<path d="{poly_d(shift(g, pad, pad))}"/>' for g in parts)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.0f}" width="{size * W / H:.0f}" height="{size}">'
            f'<g transform="translate(0 {H:.0f}) scale(1 -1)" fill="{ink}">{body}</g></svg>')

if __name__ == "__main__":
    L = Logo()
    print("cap", L.C, "xh", L.X, "SU", L.SU, "SL", L.SL, "asc", L.asc, "Tbar", L.Tbar, "Tw", L.Tw)
    html = ['<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#F3F2EE;font:13px sans-serif;color:#555}'
            '.row{display:flex;gap:28px;align-items:center;margin:0 0 22px}.dark{background:#15171C;padding:16px 22px;border-radius:10px}</style>']
    html.append('<div class="row">' + wordmark_svg(L, 220) + '</div>')
    html.append('<div class="row"><div class="dark">' + wordmark_svg(L, 90, ink="#fff") + '</div>' + wordmark_svg(L, 90, ink="#000", accent="#000") + '</div>')
    html.append('<div class="row">' + icon_svg(L, 200) + icon_svg(L, 200, ink="#fff", tile=ORANGE) +
                icon_svg(L, 32, ink="#fff", tile=ORANGE) + icon_svg(L, 16, ink="#fff", tile=ORANGE) + wordmark_svg(L, 34) + '</div>')
    html.append('<div class="row"><img src="file:///root/.claude/uploads/3e8409af-1579-56e6-81bd-bd5165aaf28a/29a08822-image.png" width="1000"></div>')
    open("sheet.html", "w").write("".join(html))
