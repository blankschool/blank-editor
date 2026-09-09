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
import base64, hashlib, io, json, math, re, sys
from pathlib import Path
import fitz
from fontTools.ttLib import TTFont, newTable
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

# (sufixo, estilo normalizado). Precisa ser par explícito, não `sufixo[1:]`: o Canva usa MAIS
# de uma abreviação para o mesmo estilo em pontos diferentes do PDF — `page.get_fonts()` relata
# "LibreCaslonCondensed-Regular" mas `span["font"]` relata "LibreCaslonCondensed-Reg" para a
# MESMA fonte (achado testando com um PDF real: a fonte reconstruía com sucesso em fonts.json,
# mas `extrair_texto` nunca achava o par e descartava pro fallback Inter mesmo assim). Sem
# normalizar as duas abreviações pro mesmo "Regular", os dois caminhos calculam família/estilo
# diferentes e a chave nunca bate — o mesmo modo de falha que o comentário de `parte()` já
# descrevia para espaço vs hífen, só que entre "Reg"/"Regular" e "Ita"/"Italic".
SUFIXOS = (
    ("-Bd", "Bold"), ("-Bold", "Bold"),
    ("-Rg", "Regular"), ("-Reg", "Regular"), ("-Regular", "Regular"),
    ("-Lt", "Light"), ("-Light", "Light"),
    ("-Md", "Medium"), ("-Medium", "Medium"),
    ("-Sb", "Semibold"), ("-Semibold", "Semibold"), ("-SemiBold", "Semibold"),
    ("-Blk", "Black"), ("-Black", "Black"),
    ("-It", "Italic"), ("-Ita", "Italic"), ("-Italic", "Italic"),
    ("-Th", "Thin"), ("-Thin", "Thin"),
)

# Peso aproximado por nome de estilo, usado só quando a fonte original do bloco não pôde
# ser reconstruída (sem arquivo embutido ou sem ToUnicode — ver os `continue` mais abaixo).
# Mapeia pro peso mais próximo que a Inter embutida do servidor cobre (server/src/render/
# builtinFaces.ts: 300/400/500/600/700/800), pra escolher a face substituta certa em vez de
# cair sempre em 400.
ESTILO_PESO = {
    "Thin": 300, "Light": 300, "Regular": 400, "Medium": 500,
    "Semibold": 600, "SemiBold": 600, "Bold": 700, "Black": 800,
    "Italic": 400,
}

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
    for sufixo, estilo in SUFIXOS:
        if base.endswith(sufixo):
            return base[:-len(sufixo)], estilo
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

def hexcolor(rgb):
    return "#%02x%02x%02x" % tuple(round(c * 255) for c in rgb)

def detectar_fundo(page):
    """Cor de fundo real da página: o último preenchimento vetorial que cobre a página
    inteira (mesmo critério do extrator do pipeline de referência, canva-import/pipeline/
    extract.py deste repo blank-editor-313c0b78 — "o último" porque um design pode empilhar
    mais de um retângulo cobrindo tudo, e o desenhado por cima é o que aparece de verdade).
    None quando nada cobre a página inteira — quem chama decide o branco-padrão."""
    r = page.rect
    encontrado = None
    for d in page.get_drawings():
        fill = d.get("fill")
        if not fill:
            continue
        x0, y0, x1, y1 = d["rect"]
        if x0 <= r.x0 + 1 and y0 <= r.y0 + 1 and x1 >= r.x1 - 1 and y1 >= r.y1 - 1:
            encontrado = fill
    if encontrado is None:
        return None
    return hexcolor(encontrado)

def caixa_nao_rotacionada(x0, y0, x1, y1, ang_rad):
    """`bloco["bbox"]` do PyMuPDF é a caixa alinhada aos eixos que ENVOLVE o texto já
    rotacionado — não a caixa original antes de girar, que é o que o `El` do Blank Editor
    guarda (x/y/w/h SEM rotação; o editor gira em torno do próprio CENTRO dessa caixa ao
    desenhar, ver `drawEl` em editor.ts). Sem desfazer isso, um título a 30° chegava com uma
    caixa maior que o texto e `rot` != 0 desenhando ele girado DUAS vezes (uma pela caixa
    inflada, outra pelo `rot`).

    O centro não muda ao girar em torno de si mesmo, então `(cx,cy)` da AABB já é o centro
    certo. Resolve W,H de volta com o sistema linear
    AABB_w = W·|cosθ| + H·|senθ|
    AABB_h = W·|senθ| + H·|cosθ|
    — singular só em θ ≈ 45°/135°/…, onde a AABB some a mesma informação nos dois eixos e não
    dá pra separar W de H; nesse caso raro, usa a própria AABB como aproximação."""
    cos_a, sin_a = abs(math.cos(ang_rad)), abs(math.sin(ang_rad))
    aabb_w, aabb_h = x1 - x0, y1 - y0
    det = cos_a * cos_a - sin_a * sin_a
    if abs(det) > 1e-3:
        w = (cos_a * aabb_w - sin_a * aabb_h) / det
        h = (cos_a * aabb_h - sin_a * aabb_w) / det
    else:
        w, h = aabb_w, aabb_h
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return cx - w / 2, cy - h / 2, w, h

def path_para_svg_d(desenho):
    """Converte os `items` de um desenho do `get_drawings()` num `d` de SVG normalizado 0..1
    dentro do próprio retângulo do desenho — o mesmo espaço que `El.fillPath` espera (ver
    `src/types.ts`: os renderers escalam o path inteiro pelo w/h do elemento em vez de
    reescrever coordenada por coordenada).

    Só liga/curva (`l`/`c`), que é o que sobra depois de tratar `re` puro à parte em
    `extrair_formas` — um item de tipo diferente (quad, arco) faz a função devolver `None`:
    melhor recusar o path inteiro do que desenhar ele com um pedaço faltando."""
    r = desenho["rect"]
    w, h = r.x1 - r.x0, r.y1 - r.y0
    if w <= 1e-6 or h <= 1e-6:
        return None
    def n(p):
        return ((p.x - r.x0) / w, (p.y - r.y0) / h)
    partes = []
    for i, item in enumerate(desenho.get("items", [])):
        op = item[0]
        if op == "l":
            p0, p1 = item[1], item[2]
            if i == 0:
                x0, y0 = n(p0)
                partes.append(f"M{x0:.5f},{y0:.5f}")
            x1, y1 = n(p1)
            partes.append(f"L{x1:.5f},{y1:.5f}")
        elif op == "c":
            p0, p1, p2, p3 = item[1], item[2], item[3], item[4]
            if i == 0:
                x0, y0 = n(p0)
                partes.append(f"M{x0:.5f},{y0:.5f}")
            x1, y1 = n(p1)
            x2, y2 = n(p2)
            x3, y3 = n(p3)
            partes.append(f"C{x1:.5f},{y1:.5f} {x2:.5f},{y2:.5f} {x3:.5f},{y3:.5f}")
        else:
            return None
    if not partes:
        return None
    return " ".join(partes) + " Z"

def extrair_formas(page):
    """Formas vetoriais de cor sólida que não sejam o próprio fundo da página — esse já virou
    `bg` em `detectar_fundo`; repeti-lo como elemento seria uma camada idêntica empilhada em
    cima de si mesma.

    Dois formatos de saída: retângulo puro (`items == ["re"]`) vira `type:"rect"`, que mapeia
    direto pro `El` tipo `rect` do editor sem mudança de render nenhuma; qualquer outra
    combinação de linha/curva vira `type:"path"` com `fillPath` (ver `path_para_svg_d`),
    mapeando pro `El` tipo `draw` com preenchimento (item 2.1 do backlog). Um desenho com
    segmento não suportado (quad, arco) ou `even_odd` (preenchimento com furo, tipo a letra
    "O") é ignorado — `El.fillPath` não carrega regra de preenchimento ainda, então um
    even_odd sairia preenchido sólido, errado; melhor não importar essa forma do que importar
    errada."""
    r = page.rect
    formas = []
    for d in page.get_drawings():
        fill = d.get("fill")
        if not fill or d.get("even_odd"):
            continue
        x0, y0, x1, y1 = d["rect"]
        cobre_pagina = x0 <= r.x0 + 1 and y0 <= r.y0 + 1 and x1 >= r.x1 - 1 and y1 >= r.y1 - 1
        if cobre_pagina:
            continue
        comandos = [it[0] for it in d.get("items", [])]
        opacity = round(d.get("fill_opacity", 1.0) or 1.0, 3)
        if comandos == ["re"]:
            formas.append(dict(
                type="rect",
                x=round(x0, 2), y=round(y0, 2), w=round(x1 - x0, 2), h=round(y1 - y0, 2),
                fill=hexcolor(fill), opacity=opacity,
            ))
            continue
        caminho = path_para_svg_d(d)
        if caminho is None:
            continue
        formas.append(dict(
            type="path",
            x=round(x0, 2), y=round(y0, 2), w=round(x1 - x0, 2), h=round(y1 - y0, 2),
            fillPath=caminho, fill=hexcolor(fill), opacity=opacity,
        ))
    return formas

def extrair_texto(page, peso_por_estilo):
    """Blocos de texto da pagina, no formato que `El` do Blank Editor espera
    (x/y/w/h/text/font/weight/size/fill). Um bloco vira um elemento so — Canva normalmente usa
    uma caixa de texto por estilo, e agrupar por bloco (em vez de por span) evita fragmentar uma
    frase em dezenas de elementos de uma letra so.

    LIMITACAO CONHECIDA: um bloco com mistura de estilos (negrito no meio de uma frase, por
    exemplo) vira um elemento so com o estilo do PRIMEIRO span — dividir por span preservaria o
    estilo exato, mas fragmentaria a caixa de texto em varios elementos que o editor não sabe
    reagrupar. Rotacao vem do vetor `dir` — que o PyMuPDF expõe na LINHA, não no span (um span
    não tem chave "dir" nenhuma; pegar `primeiro_span.get("dir", (1,0))` sempre batia no default e
    NUNCA capturava rotação nenhuma, bug real achado testando com um PDF girado de verdade — a
    caixa saía w/h maiores que o texto, sem girar, com `rot: 0` mesmo pra texto a 30°)."""
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
        # Guardado ANTES do fallback trocar `familia`: é o nome que um matching por IA
        # (feature 3, server/src/render/googleFontMatch.ts) usa como pista de qual Google
        # Font parece com o que a arte original usava — sem isso, uma vez substituído por
        # "Inter" não haveria como saber que aquele bloco é candidato a um match melhor.
        font_original = None
        if peso is None:
            # A fonte deste bloco nao foi reconstruida (sem arquivo embutido ou sem ToUnicode).
            # Antes isso descartava o bloco em silencio; agora cai pra Inter, que o servidor
            # sempre tem embutida (server/src/render/builtinFaces.ts) — o texto sobrevive com
            # uma fonte parecida em vez de desaparecer do design importado sem aviso.
            font_original = f"{familia}-{estilo}"
            print(f"  {familia}-{estilo}: fonte nao reconstruida, usando Inter peso "
                  f"{ESTILO_PESO.get(estilo, 400)} como substituta")
            familia, peso = "Inter", ESTILO_PESO.get(estilo, 400)
        x0, y0, x1, y1 = bloco["bbox"]
        dx, dy = linhas[0].get("dir", (1, 0))
        ang = math.atan2(-dy, dx)
        x, y, w, h = caixa_nao_rotacionada(x0, y0, x1, y1, ang)
        elementos.append(dict(
            type="text",
            x=round(x, 2), y=round(y, 2),
            w=round(w, 2), h=round(h, 2),
            text=texto,
            font=familia,
            weight=peso,
            size=round(primeiro_span.get("size", 12), 2),
            fill="#%06x" % (primeiro_span.get("color", 0) & 0xFFFFFF),
            rot=round(math.degrees(ang), 2),
            **({"fontOriginal": font_original} if font_original else {}),
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

destino.mkdir(parents=True, exist_ok=True)  # criado aqui pra existir mesmo sem fonte nenhuma
                                             # pra reconstruir — `constroi()` só cria a pasta
                                             # se rodar pelo menos uma vez; uma página sem
                                             # texto (só forma/imagem) tinha `por_familia_estilo`
                                             # vazio e nunca chegava lá, e o write_text logo
                                             # abaixo falhava com "No such file or directory".
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
    formas = extrair_formas(pagina)
    texto = extrair_texto(pagina, peso_por_estilo)
    fundo = detectar_fundo(pagina)
    # Formas primeiro: no editor, elementos mais adiante na lista desenham por cima —
    # um retângulo de fundo/destaque precisa ficar atrás do texto, nunca na frente.
    texto_por_pagina.append({"page": numero, "elements": formas + texto, "bg": fundo})
    print(f"  pagina {numero}: {len(formas)} formas, {len(texto)} blocos de texto, "
          f"fundo {fundo or '(nenhum — branco padrão)'}")
(destino / "text.json").write_text(json.dumps(texto_por_pagina, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
