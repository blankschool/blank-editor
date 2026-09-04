#!/usr/bin/env python3
"""
Reconstrói as fontes REAIS do PDF exportado do Canva, e extrai o texto vetorial de cada página.

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

Método de fontes adaptado de canva-import/pipeline/mergefonts.py do repo blank-editor-313c0b78.
A extração de texto (`extrair_texto`) usa `page.get_text("dict")`, que já vem com bbox/fonte/
tamanho por span — dispensa portar o parser de content-stream daquele outro repo, já que o
PyMuPDF é dependência deste arquivo de qualquer forma.
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
    navegador não alternaria entre elas.

    O espaço vira hífen antes de qualquer coisa: `pagina.get_fonts()` e
    `span["font"]` (usados em dois pontos diferentes deste arquivo para a MESMA fonte)
    às vezes relatam o nome com separador diferente ("BlankFixture Regular" vs
    "BlankFixture-Regular", achado testando com uma fonte sintética) — sem normalizar,
    os dois viram (familia, estilo) diferentes e `extrair_texto` descarta o bloco
    inteiro em silêncio, achando que a fonte dele nunca foi reconstruída."""
    base = base.replace(" ", "-")
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

def constroi(entries, familia, estilo, destino):
    """`entries` é uma lista de (ttf_bytes, uni) — um par por página que usa esta
    (familia, estilo). Cada página do PDF do Canva embute seu PRÓPRIO subset Identity-H,
    contendo só os glifos que aquela página usa — sem unir os subsets, uma família que
    aparece na página 1 só com "ABC" e na página 3 com "XYZ" perderia X/Y/Z (a página 3
    ficaria muda: a fonte final "não tem" essas letras, `extrair_texto` já filtra por
    glifo disponível em outro lugar, então o efeito visível seria texto ausente, sem erro
    nenhum). Método adaptado de `build()` em canva-import/pipeline/mergefonts.py do repo
    blank-editor-313c0b78, que resolve o mesmo problema pro pipeline de referência."""
    base_font, upem = None, None
    glyphs, adv, lsb = {}, {}, {}
    for ttf_bytes, uni in entries:
        f = TTFont(io.BytesIO(ttf_bytes))
        if base_font is None:
            base_font, upem = f, f["head"].unitsPerEm
        order, gset, hm = f.getGlyphOrder(), f.getGlyphSet(), f["hmtx"].metrics
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
    f = base_font

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

def extrair_texto(page, peso_por_estilo):
    """Blocos de texto da pagina, no formato que `El` do Blank Editor espera
    (x/y/w/h/text/font/weight/size/fill). Um bloco vira um elemento so — Canva normalmente usa
    uma caixa de texto por estilo, e agrupar por bloco (em vez de por span) evita fragmentar uma
    frase em dezenas de elementos de uma letra so.

    LIMITACAO CONHECIDA: um bloco com mistura de estilos (negrito no meio de uma frase, por
    exemplo) vira um elemento so com o estilo do PRIMEIRO span — dividir por span preservaria o
    estilo exato, mas fragmentaria a caixa de texto em varios elementos que o editor não sabe
    reagrupar. Rotacao vem do vetor `dir` da linha; só 0°/180° tem confianca (o mesmo limite que
    `placementFromMatrix`, em pdfSource.ts, documenta pro caminho de imagem)."""
    import math
    elementos = []
    for bloco in page.get_text("dict")["blocks"]:
        if bloco.get("type") != 0:
            continue
        linhas = bloco.get("lines") or []
        if not linhas or not linhas[0].get("spans"):
            continue
        primeiro_span = linhas[0]["spans"][0]
        texto = "\n".join("".join(s["text"] for s in linha["spans"]) for linha in linhas)
        if not texto.strip():
            continue
        familia, estilo = parte(primeiro_span["font"].split("+")[-1])
        peso = peso_por_estilo.get((familia, estilo))
        if peso is None:
            # A fonte deste bloco nao foi reconstruida (sem arquivo embutido ou sem ToUnicode) —
            # sem uma DocFont correspondente, o bloco ficaria apontando pra familia que o editor
            # nao acha. Melhor deixar de fora do que desenhar com a fonte errada.
            continue
        x0, y0, x1, y1 = bloco["bbox"]
        dx, dy = primeiro_span.get("dir", (1, 0))
        elementos.append(dict(
            type="text",
            x=round(x0, 2), y=round(y0, 2),
            w=round(x1 - x0, 2), h=round(y1 - y0, 2),
            text=texto,
            font=familia,
            weight=peso,
            size=round(primeiro_span.get("size", 12), 2),
            fill="#%06x" % (primeiro_span.get("color", 0) & 0xFFFFFF),
            rot=round(math.degrees(math.atan2(-dy, dx)), 2),
        ))
    return elementos


pdf, destino = sys.argv[1], Path(sys.argv[2])
doc = fitz.open(pdf)
# Junta os subsets de TODAS as páginas por (familia, estilo) antes de reconstruir — ver o
# docstring de `constroi` pro porquê de não bastar pegar a primeira página que aparecer.
por_familia_estilo = {}
for pagina in doc:
    for xref, ext, tipo, base, nome, enc in pagina.get_fonts(full=False):
        familia, estilo = parte(base.split("+")[-1])
        dados = doc.extract_font(xref)
        ttf = dados[3]
        if not ttf:
            print(f"  {base}: sem arquivo embutido, pulada"); continue
        uni = to_unicode(doc, xref)
        if not uni:
            print(f"  {base}: sem ToUnicode, pulada"); continue
        por_familia_estilo.setdefault((familia, estilo), []).append((ttf, uni))

resultado = []
for (familia, estilo), entries in por_familia_estilo.items():
    resultado.append(constroi(entries, familia, estilo, destino))
    r = resultado[-1]
    aviso = "  [embedding restrito]" if r["os2_fs_type"] & 0x000E else ""
    print(f"  {r['familia']:14} {r['estilo']:10} peso {r['peso']:3}  {r['glifos']:2} glifos  "
          f"{r['kb']:5.1f} KB  fsType 0x{r['os2_fs_type']:04x}{aviso}"
          f"{'  (' + str(len(entries)) + ' páginas)' if len(entries) > 1 else ''}")
(destino / "fonts.json").write_text(json.dumps(resultado, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

peso_por_estilo = {(r["familia"], r["estilo"]): r["peso"] for r in resultado}
texto_por_pagina = []
for numero, pagina in enumerate(doc, start=1):
    elementos = extrair_texto(pagina, peso_por_estilo)
    texto_por_pagina.append({"page": numero, "elements": elementos})
    print(f"  pagina {numero}: {len(elementos)} blocos de texto")
(destino / "text.json").write_text(json.dumps(texto_por_pagina, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
