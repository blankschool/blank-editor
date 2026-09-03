#!/usr/bin/env python3
"""
Reconstrói as fontes REAIS do PDF exportado do Canva.

Cada família vem embutida como subset Identity-H: os glifos estão lá, mas
indexados por CID e sem `cmap` utilizável, então nada consegue desenhar texto com
elas. Aqui se remapeia por Unicode (via `ToUnicode`) e se reescreve o `name`/OS2
para uma face nomeada de verdade — é isso que faz o navegador e o fontconfig
acharem "NYTFranklin peso 300".

Único passo do pipeline que não é Node: reconstruir contornos TrueType pede fontTools, e
não há equivalente prático em JS. Rode num venv:

    python3 -m venv .venv && .venv/bin/pip install fonttools brotli pymupdf
    .venv/bin/python scripts/canva-pdf-fonts.py <arquivo.pdf> ../imports/<design>/fonts

Os .woff2 vão para public/fonts (o navegador, via src/designFonts.css) e os .ttf para
server/fonts (o fontconfig do container, via server/Dockerfile). Sem os dois lados, editor e
render desenham o mesmo texto com fontes diferentes.

ATENÇÃO: o subset traz só os glifos que aquela arte usava. Trocar o texto por uma letra que
não estava no original não desenha nada — é o limite de usar a fonte do PDF em vez de
licenciá-la.

Método adaptado de canva-import/pipeline/mergefonts.py do repo blank-editor-313c0b78.
"""
import base64, hashlib, io, json, re, sys
from pathlib import Path
import fitz
from fontTools.ttLib import TTFont, newTable
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

SUFIXOS = ("-Bd","-Bold","-Rg","-Regular","-Lt","-Light","-Md","-Medium",
           "-Sb","-Semibold","-SemiBold","-Blk","-Black","-It","-Italic","-Th","-Thin")

def parte(base):
    """NYTFranklin-Bold -> ("NYTFranklin", "Bold"). O peso vem do OS/2; manter o
    sufixo no nome da família faria Bold e Light virarem famílias diferentes e o
    navegador não alternaria entre elas."""
    for s in SUFIXOS:
        if base.endswith(s):
            return base[:-len(s)], s[1:]
    return base, "Regular"

def to_unicode(doc, xref):
    """CID -> caractere, lido do CMap /ToUnicode da fonte."""
    val = doc.xref_get_key(xref, "ToUnicode")
    if not val or val[0] != "xref":
        return {}
    cm = doc.xref_stream(int(val[1].split()[0])).decode("latin1")
    out = {}
    for blk in re.findall(r"beginbfchar(.*?)endbfchar", cm, re.S):
        for a, c in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            out[int(a, 16)] = "".join(chr(int(c[i:i+4], 16)) for i in range(0, len(c), 4))
    for blk in re.findall(r"beginbfrange(.*?)endbfrange", cm, re.S):
        for lo, hi, d in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            lo, hi, d = int(lo,16), int(hi,16), int(d,16)
            for i in range(hi-lo+1):
                out[lo+i] = chr(d+i)
    return out

def constroi(ttf_bytes, uni, familia, estilo, destino):
    f = TTFont(io.BytesIO(ttf_bytes))
    upem = f["head"].unitsPerEm
    order, gset, hm = f.getGlyphOrder(), f.getGlyphSet(), f["hmtx"].metrics

    glyphs, adv, lsb = {}, {}, {}
    for cid, ch in uni.items():
        if cid >= len(order) or len(ch) != 1 or ch in glyphs:
            continue
        src = order[cid]
        # Glifos acentuados são compostos e referenciam componentes por índice,
        # que não sobrevive à cópia entre fontes — decompor evita remapear.
        rec = DecomposingRecordingPen(gset)
        gset[src].draw(rec)
        pen = TTGlyphPen(None)
        rec.replay(pen)
        glyphs[ch] = pen.glyph()
        # o lsb tem que vir junto: com lsb=0 o rasterizador desloca o contorno
        # e o texto sai mais estreito
        adv[ch], lsb[ch] = hm[src]

    chars = sorted(glyphs)
    gname = lambda c: "u%04X" % ord(c)
    order_out = [".notdef"] + [gname(c) for c in chars]
    out = TTFont()
    out.setGlyphOrder(order_out)

    glyf = newTable("glyf"); glyf.glyphOrder = order_out
    glyf.glyphs = {".notdef": TTGlyphPen(None).glyph()}
    metrics = {".notdef": (int(upem*0.5), 0)}
    for c in chars:
        glyf.glyphs[gname(c)] = glyphs[c]
        metrics[gname(c)] = (int(adv[c]), int(lsb[c]))
    out["glyf"] = glyf
    out["loca"] = newTable("loca")          # gerada ao compilar glyf, mas precisa existir
    hmtx = newTable("hmtx"); hmtx.metrics = metrics; out["hmtx"] = hmtx
    for t in ("head","hhea","maxp","OS/2"):
        out[t] = f[t]
    out["maxp"].numGlyphs = len(order_out)
    out["hhea"].numberOfHMetrics = len(order_out)

    post = newTable("post"); post.formatType = 3.0; post.italicAngle = 0
    post.underlinePosition = -100; post.underlineThickness = 50; post.isFixedPitch = 0
    post.minMemType42 = post.maxMemType42 = post.minMemType1 = post.maxMemType1 = 0
    out["post"] = post

    subs = []
    for pid, eid in ((3,1),(0,3)):
        s = CmapSubtable.newSubtable(4)
        s.platformID, s.platEncID, s.language = pid, eid, 0
        s.cmap = {ord(c): gname(c) for c in chars}
        subs.append(s)
    cm = newTable("cmap"); cm.tableVersion = 0; cm.tables = subs; out["cmap"] = cm

    # Família em 1 e estilo em 2 (não tudo no 1): é assim que o fontconfig
    # entende Light/Semibold/Bold como faces de UMA família.
    nm = newTable("name"); nm.names = []; out["name"] = nm
    for nid, valor in ((1, familia), (2, estilo), (4, f"{familia} {estilo}"),
                       (6, f"{familia}-{estilo}")):
        out["name"].setName(valor, nid, 3, 1, 0x409)

    destino.mkdir(parents=True, exist_ok=True)
    stem = f"{familia}-{estilo}"
    out.save(destino / f"{stem}.ttf")
    w = TTFont(destino / f"{stem}.ttf")     # recarrega: garante glyf/loca consistentes
    w.flavor = "woff2"
    w.save(destino / f"{stem}.woff2")
    o = w["OS/2"]; u = w["head"].unitsPerEm
    typo = bool(o.fsSelection & (1 << 7))
    # sha256 dos BYTES do SFNT: é a identidade da face no registry e a chave do cache do
    # renderer. Calculado depois do save, sobre o arquivo que de fato vai subir.
    sha = hashlib.sha256((destino / f"{stem}.ttf").read_bytes()).hexdigest()
    # usWidthClass 1..9; 5 é normal. Mapeado para o vocabulário CSS de font-stretch.
    STRETCH = ["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal",
               "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"]
    largura = STRETCH[min(max(o.usWidthClass, 1), 9) - 1]
    return dict(arquivo=stem, familia=familia, estilo=estilo,
                peso=o.usWeightClass or 400, glifos=len(chars),
                texto="".join(chars),
                sha256=sha,
                postscript_name=f"{familia}-{estilo}",
                stretch=largura,
                os2_fs_type=int(o.fsType),
                asc=round((o.sTypoAscender if typo else o.usWinAscent)/u, 5),
                desc=round((-o.sTypoDescender if typo else o.usWinDescent)/u, 5),
                kb=round((destino / f"{stem}.woff2").stat().st_size/1024, 1))

pdf, destino = sys.argv[1], Path(sys.argv[2])
doc = fitz.open(pdf)
resultado = []
for xref, ext, tipo, base, nome, enc in doc[0].get_fonts(full=False):
    dados = doc.extract_font(xref)
    ttf = dados[3]
    if not ttf:
        print(f"  {base}: sem arquivo embutido, pulada"); continue
    uni = to_unicode(doc, xref)
    if not uni:
        print(f"  {base}: sem ToUnicode, pulada"); continue
    familia, estilo = parte(base.split("+")[-1])
    resultado.append(constroi(ttf, uni, familia, estilo, destino))
    r = resultado[-1]
    aviso = "  [embedding restrito]" if r["os2_fs_type"] & 0x000E else ""
    print(f"  {r['familia']:14} {r['estilo']:10} peso {r['peso']:3}  {r['glifos']:2} glifos  "
          f"{r['kb']:5.1f} KB  fsType 0x{r['os2_fs_type']:04x}{aviso}")
(destino / "fonts.json").write_text(json.dumps(resultado, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
