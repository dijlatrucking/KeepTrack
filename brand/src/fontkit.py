# Small helpers: load a font (optionally a variable-font instance), shape text with HarfBuzz,
# and get glyph outlines as SVG path data (font units, y up).
import io
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.recordingPen import RecordingPen
import uharfbuzz as hb

class Font:
    def __init__(self, path, axes=None):
        tt = TTFont(path)
        if axes and "fvar" in tt:
            from fontTools.varLib import instancer
            tt = instancer.instantiateVariableFont(tt, axes)
        buf = io.BytesIO()
        tt.flavor = None
        tt.save(buf)
        self.data = buf.getvalue()
        self.tt = TTFont(io.BytesIO(self.data))
        self.gs = self.tt.getGlyphSet()
        self.upem = self.tt["head"].unitsPerEm
        os2 = self.tt["OS/2"]
        self.cap = getattr(os2, "sCapHeight", 0) or 700
        self.xh = getattr(os2, "sxHeight", 0) or 500
        face = hb.Face(self.data)
        self.hbfont = hb.Font(face)
        self.order = self.tt.getGlyphOrder()

    def shape(self, text, features=None):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hbfont, buf, features or {"kern": True, "liga": False})
        out = []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            out.append((self.order[info.codepoint], pos.x_advance, pos.x_offset, pos.y_offset))
        return out

    def path(self, gname):
        pen = SVGPathPen(self.gs)
        self.gs[gname].draw(pen)
        return pen.getCommands()

    def record(self, gname):
        pen = RecordingPen()
        self.gs[gname].draw(pen)
        return pen.value

    def advance(self, gname):
        return self.tt["hmtx"][gname][0]

def text_svg(font, text, size_cap=100, x0=0, y0=None, fill="#15171C", tracking=0):
    """Returns (svg_group, width) with the text's cap height = size_cap px; baseline at y0."""
    s = size_cap / font.cap
    y0 = size_cap if y0 is None else y0
    parts, x = [], 0
    for g, adv, xo, yo in font.shape(text):
        d = font.path(g)
        if d:
            parts.append(f'<path transform="translate({(x0 + (x + xo) * s):.2f},{y0:.2f}) scale({s:.5f},{-s:.5f})" d="{d}" fill="{fill}"/>')
        x += adv + tracking
    return "".join(parts), x * s
