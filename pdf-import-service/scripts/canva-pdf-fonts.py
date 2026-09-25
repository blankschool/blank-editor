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
A extração de texto (`extrair_texto`) usa `page.get_texttrace()` + agrupamento em
pdf_layout.py — traz ordem de pintura (seqno), opacidade, métricas e origem de cada caractere.
"""
import base64, hashlib, io, json, math, re, sys
from pathlib import Path
import fitz
import pdf_layout
import pdf_shapes
from fontTools.ttLib import TTFont, newTable
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

# (abreviação, estilo normalizado) por peso — a base pra gerar SUFIXOS. Separado de PESOS pra
# poder combinar cada peso com "Italic" sem repetir a lista à mão (ver `_sufixos` abaixo).
PESOS = (
    ("Bd", "Bold"), ("Bold", "Bold"),
    ("Rg", "Regular"), ("Reg", "Regular"), ("Regular", "Regular"),
    ("Xlt", "ExtraLight"), ("ExtraLight", "ExtraLight"),
    ("Lt", "Light"), ("Light", "Light"),
    ("Md", "Medium"), ("Medium", "Medium"),
    ("Sb", "Semibold"), ("Semibold", "Semibold"), ("SemiBold", "Semibold"),
    ("Db", "Semibold"), ("DemiBold", "Semibold"), ("Demi", "Semibold"),
    ("Xbd", "ExtraBold"), ("ExtraBold", "ExtraBold"),
    ("Blk", "Black"), ("Black", "Black"), ("Hv", "Black"), ("Heavy", "Black"),
    ("Th", "Thin"), ("Thin", "Thin"),
)
ITALICOS = ("Italic", "Ita", "It")

def _sufixos():
    """Gera (sufixo, estilo normalizado) a partir de PESOS x ITALICOS, em vez de listado à mão:
    precisa ser par explícito, não `sufixo[1:]`, porque o Canva usa MAIS de uma abreviação para
    o mesmo estilo em pontos diferentes do PDF — `page.get_fonts()` relata
    "LibreCaslonCondensed-Regular" mas `span["font"]` relata "LibreCaslonCondensed-Reg" para a
    MESMA fonte (achado testando com um PDF real: a fonte reconstruía com sucesso em
    fonts.json, mas `extrair_texto` nunca achava o par e descartava pro fallback Inter mesmo
    assim, ea0f8fa). Sem normalizar as abreviações pro mesmo estilo, os dois caminhos calculam
    família/estilo diferentes e a chave nunca bate.

    A combinação com Italic existe pelo mesmo motivo: exportadores costumam colar o peso e
    "Italic" sem separador no meio ("Roboto-BoldItalic"), então um sufixo só de peso (`-Bold`)
    ou só de itálico (`-Italic`) não fecha com o final da string — cai no default (família
    errada) do mesmo jeito que "-Reg" caía antes de existir na lista.

    Ordenado do sufixo mais longo pro mais curto: paranoia contra um sufixo curto (`-It`)
    aparecer antes de um composto (`-BoldItalic`) que também terminaria batendo — na prática
    `endswith` já não colide aqui (nenhum sufixo curto é sufixo textual de outro composto), mas
    ordenar por tamanho custa nada e evita esse tipo de bug reaparecer se a lista crescer."""
    pares = []
    for abrev, estilo in PESOS:
        pares.append((f"-{abrev}", estilo))
        for ita in ITALICOS:
            pares.append((f"-{abrev}{ita}", f"{estilo} Italic"))
    for ita in ITALICOS:
        pares.append((f"-{ita}", "Italic"))
    return tuple(sorted(pares, key=lambda par: -len(par[0])))

SUFIXOS = _sufixos()

# Peso aproximado por nome de estilo, usado só quando a fonte original do bloco não pôde
# ser reconstruída (sem arquivo embutido ou sem ToUnicode — ver os `continue` mais abaixo).
# Mapeia pro peso mais próximo que a Inter embutida do servidor cobre (server/src/render/
# builtinFaces.ts: 300/400/500/600/700/800), pra escolher a face substituta certa em vez de
# cair sempre em 400. Itálico não muda peso, então o lookup abaixo (`extrair_texto`) tira o
# " Italic" do estilo antes de consultar aqui — sem isso teria que duplicar cada entrada.
ESTILO_PESO = {
    "Thin": 300, "ExtraLight": 300, "Light": 300, "Regular": 400, "Medium": 500,
    "Semibold": 600, "Bold": 700, "ExtraBold": 800, "Black": 800,
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

def extrair_formas(page):
    """Formas vetoriais (preenchimento, contorno, even-odd) — ver pdf_shapes.py. O fundo da
    página (preenchimento que cobre tudo) fica de fora: já virou `bg` em `detectar_fundo`."""
    r = page.rect
    formas = []
    for d in page.get_drawings():
        el = pdf_shapes.desenho_para_elemento(d, (r.x0, r.y0, r.x1, r.y1))
        if el:
            formas.append(el)
    return formas


def _valor(doc, xref, chave):
    tipo, valor = doc.xref_get_key(xref, chave)
    return None if tipo == "null" else valor


class RecursosPdf:
    """Recursos (Shading, XObject) de uma página ou Form XObject, para
    `pdf_shapes.usos_de_shading`. Form sem /Resources herda os do pai."""
    def __init__(self, doc, xref, pai=None, prefixo="Resources/"):
        self.doc, self.pai = doc, pai
        self.shadings = self._nomes(xref, prefixo + "Shading")
        self.xobjects = self._nomes(xref, prefixo + "XObject")
        if pai and not self.shadings and not self.xobjects:
            self.shadings, self.xobjects = pai.shadings, pai.xobjects

    def _nomes(self, xref, chave):
        tipo, valor = self.doc.xref_get_key(xref, chave)
        if tipo == "xref":
            valor = self.doc.xref_object(int(valor.split()[0]))
        return {k: int(v) for k, v in re.findall(r"/([^\s/<>\[\]]+)\s+(\d+)\s+0\s+R", valor or "")}

    def shading(self, nome):
        return self.shadings.get(nome)

    def form(self, nome):
        xref = self.xobjects.get(nome)
        if not xref or _valor(self.doc, xref, "Subtype") != "/Form":
            return None
        matriz = pdf_shapes._numeros(_valor(self.doc, xref, "Matrix")) or [1, 0, 0, 1, 0, 0]
        return self.doc.xref_stream(xref) or b"", tuple(matriz[:6]), RecursosPdf(self.doc, xref, self)


def extrair_gradientes(page, doc):
    """Gradientes (`sh`) da página E dos Form XObjects dentro dela, com `z` da ordem de
    pintura. Recorte retangular vira `rect` com `grad`; recorte com outro formato (círculo,
    forma, texto em contorno) vira `path` com o próprio formato em `fillPath` + `grad`."""
    log = page.get_bboxlog()
    areas = [(i, rr) for i, (tipo, rr) in enumerate(log) if "shade" in tipo]
    if not areas:
        return []
    usos = pdf_shapes.usos_de_shading(page.read_contents(), RecursosPdf(doc, page.xref))
    get = lambda x, k: _valor(doc, x, k)
    pm = page.transformation_matrix
    pagina_m = (pm.a, pm.b, pm.c, pm.d, pm.e, pm.f)
    out = []
    pr = page.rect
    for (seq, bbox_log), uso in zip(areas, usos):
        xref, ctm, recorte = uso["shading"], uso["ctm"], uso["recorte"]
        caixa = pdf_shapes.caixa_do_gradiente(tuple(bbox_log), recorte, pagina_m, (pr.x0, pr.y0, pr.x1, pr.y1))
        if caixa is None or not xref:
            continue
        try:
            tipo = int(float(get(xref, "ShadingType") or 0))
            if tipo not in (2, 3):
                continue
            coords = pdf_shapes._numeros(get(xref, "Coords"))
            fx = pdf_shapes._refs(get(xref, "Function"))
            if not fx or len(coords) < 4:
                continue
            paradas = pdf_shapes.paradas_da_funcao(get, fx[0])
            if len(paradas) < 2:
                continue
            x0, y0, x1, y1 = caixa
            g, css = pdf_shapes.gradiente_css(tipo, coords, ctm, pagina_m, (x0, y0, x1, y1), paradas)
        except Exception as erro:  # um gradiente malformado não derruba a página
            print(f"  gradiente {xref} ignorado: {erro}")
            continue
        base = dict(x=round(x0, 2), y=round(y0, 2), w=round(x1 - x0, 2), h=round(y1 - y0, 2),
                    fill=css, grad=g, opacity=1.0, z=seq)
        if recorte and not recorte["retangular"]:
            el = dict(type="path", fillPath=pdf_shapes.recorte_para_path(recorte, pagina_m, caixa), **base)
            if recorte["evenodd"]:
                el["fillRule"] = "evenodd"
            out.append(el)
        else:
            out.append(dict(type="rect", **base))
    return out


def estilo_do_span_factory(peso_por_estilo):
    """Fonte/peso/itálico do editor para um span do texttrace. Quando a fonte do span não foi
    reconstruída (sem arquivo embutido ou sem ToUnicode), cai pra Inter — que o servidor sempre
    tem embutida (server/src/render/builtinFaces.ts) — e guarda o nome original em
    `fontOriginal` como pista pro matching de Google Font por IA
    (server/src/render/googleFontMatch.ts)."""
    def estilo(span):
        familia, est = parte(span["font"].split("+")[-1])
        peso = peso_por_estilo.get((familia, est))
        out = dict(font=familia, fontStyle=est, italic="Italic" in est)
        if peso is None:
            out["fontOriginal"] = f"{familia}-{est}"
            out["font"] = "Inter"
            peso = ESTILO_PESO.get(est.removesuffix(" Italic").removesuffix("Italic") or "Regular", 400)
        out["weight"] = peso
        return out
    return estilo


def avanco_natural_factory(doc):
    """Avanço natural (em em) de um glifo pelo ID, lido da tabela hmtx da fonte embutida
    ORIGINAL (não da reconstruída: o glyph id do texttrace é o do subset embutido). Serve pra
    medir o espaçamento entre letras aplicado no Canva. Fonte que o fontTools não abre (CFF
    nu, Type3) devolve None e simplesmente não contribui pra medição."""
    fontes = {}
    for pagina in doc:
        for xref, ext, tipo, base, nome, enc in pagina.get_fonts(full=False):
            chave = parte(base.split("+")[-1])
            if chave in fontes:
                continue
            try:
                dados = doc.extract_font(xref)[3]
                tt = TTFont(io.BytesIO(dados), lazy=True)
                upm = tt["head"].unitsPerEm
                ordem = tt.getGlyphOrder()
                hmtx = tt["hmtx"].metrics
                fontes[chave] = (upm, ordem, hmtx)
            except Exception:
                fontes[chave] = None
    def avanco(span, gid):
        f = fontes.get(parte(span["font"].split("+")[-1]))
        if not f or gid is None or gid < 0:
            return None
        upm, ordem, hmtx = f
        if gid >= len(ordem):
            return None
        m = hmtx.get(ordem[gid])
        return m[0] / upm if m else None
    return avanco


def extrair_texto(page, estilo_do_span, avanco_natural):
    """Texto da página via `get_texttrace()` — ver o cabeçalho de pdf_layout.py. Cada
    parágrafo vira UMA caixa de texto editável com: runs de estilo (negrito/cor no meio da
    frase), quebras de linha iguais às do PDF, entrelinha (`lh`) e espaçamento entre letras
    (`ls`) medidos, alinhamento detectado, rotação e `z` (ordem de pintura real)."""
    spans = pdf_layout.spans_visiveis(page.get_texttrace())
    linhas = pdf_layout.agrupar_linhas(spans)
    paragrafos = pdf_layout.agrupar_paragrafos(linhas, pdf_layout.seqnos_nao_texto(page))
    elementos = []
    for par in paragrafos:
        el = pdf_layout.paragrafo_para_elemento(par, estilo_do_span, avanco_natural)
        if el["text"].strip():
            elementos.append(el)
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
estilo_do_span = estilo_do_span_factory(peso_por_estilo)
avanco_natural = avanco_natural_factory(doc)
texto_por_pagina = []
for numero, pagina in enumerate(doc, start=1):
    formas = extrair_formas(pagina) + extrair_gradientes(pagina, doc)
    texto = extrair_texto(pagina, estilo_do_span, avanco_natural)
    fundo = detectar_fundo(pagina)
    # Cada elemento carrega `z` (índice em get_bboxlog = ordem real de pintura); quem monta a
    # página (orchestrate.ts) ordena por ele, junto com as imagens (`images`, casadas por bbox).
    texto_por_pagina.append({"page": numero, "elements": formas + texto, "bg": fundo,
                             "images": pdf_layout.seqnos_de_imagens(pagina)})
    print(f"  pagina {numero}: {len(formas)} formas, {len(texto)} blocos de texto, "
          f"fundo {fundo or '(nenhum — branco padrão)'}")
(destino / "text.json").write_text(json.dumps(texto_por_pagina, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
