"""
Formas vetoriais (preenchimento, contorno, regra even-odd) e gradientes de uma página de PDF.

Formas vêm de `page.get_drawings()`; gradientes (operador `sh` do PDF) não aparecem lá — são
lidos do próprio PDF: a posição/ordem de pintura pelas entradas "fill-shade" de
`page.get_bboxlog()`, e cores/direção pelo dicionário /Shading (tipos 2 axial e 3 radial, com
funções tipo 2 e tipo 3 costuradas — o que Canva/Figma/Illustrator exportam).

Tudo sai em PONTOS do PDF; orchestrate.ts escala para px.
"""
import math
import re


def _xy(p):
    return (p.x, p.y) if hasattr(p, "x") else (p[0], p[1])


def _rgb_hex(color):
    if color is None:
        return None
    color = tuple(color)
    if len(color) == 1:
        color = color * 3
    if len(color) == 4:
        c, m, y, k = color
        color = ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v * 255))) for v in color[:3])


def path_d(items, rect, fechar):
    """`items` do get_drawings -> `d` de SVG normalizado 0..1 dentro de `rect` (mesma
    convenção de `El.fillPath`). Abre subpath novo (M) sempre que um item não começa onde o
    anterior terminou — sem isso, um ícone com vários contornos virava um só, ligado por
    retas. Suporta l, c, re e qu. None se algo não é suportado."""
    x0, y0, x1, y1 = rect
    w, h = x1 - x0, y1 - y0
    if w <= 1e-6 or h <= 1e-6:
        return None

    def n(p):
        px, py = _xy(p)
        return f"{(px - x0) / w:.5f},{(py - y0) / h:.5f}"

    partes, ultimo = [], None
    for item in items:
        op = item[0]
        if op in ("re", "qu"):
            if op == "re":
                r = item[1]
                rx0, ry0, rx1, ry1 = (r.x0, r.y0, r.x1, r.y1) if hasattr(r, "x0") else r
                pts = [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]
            else:
                q = item[1]
                pts = [_xy(q.ul), _xy(q.ur), _xy(q.lr), _xy(q.ll)] if hasattr(q, "ul") else [_xy(p) for p in q]
            partes.append("M" + n(pts[0]) + "".join(" L" + n(p) for p in pts[1:]) + " Z")
            ultimo = None
            continue
        if op not in ("l", "c"):
            return None
        ini = _xy(item[1])
        if ultimo is None or math.dist(ini, ultimo) > 1e-3:
            partes.append("M" + n(item[1]))
        if op == "l":
            partes.append("L" + n(item[2]))
            ultimo = _xy(item[2])
        else:
            partes.append(f"C{n(item[2])} {n(item[3])} {n(item[4])}")
            ultimo = _xy(item[4])
    if not partes:
        return None
    d = " ".join(partes)
    return d + (" Z" if fechar and not d.endswith("Z") else "")


def desenho_para_elemento(d, pagina_rect):
    """Um desenho do get_drawings() -> elemento `rect`/`path` (ou None). `pagina_rect` é
    (x0,y0,x1,y1) da página: preenchimento que cobre tudo é o fundo (vira `Page.bg`)."""
    tipo = d.get("type") or "f"
    fill = _rgb_hex(d.get("fill")) if "f" in tipo else None
    stroke = _rgb_hex(d.get("color")) if "s" in tipo else None
    largura = d.get("width") or 0
    if stroke and largura <= 0:
        largura = 1.0
    if not fill and not stroke:
        return None
    r = d["rect"]
    x0, y0, x1, y1 = (r.x0, r.y0, r.x1, r.y1) if hasattr(r, "x0") else r
    px0, py0, px1, py1 = pagina_rect
    if fill and not stroke and x0 <= px0 + 1 and y0 <= py0 + 1 and x1 >= px1 - 1 and y1 >= py1 - 1:
        return None
    opacidade = d.get("fill_opacity") if fill else d.get("stroke_opacity")
    opacidade = round(1.0 if opacidade is None else opacidade, 3)
    if opacidade <= 0:
        return None
    base = dict(z=d.get("seqno", 0), opacity=opacidade)
    if stroke:
        base.update(stroke=stroke, strokeWidth=round(largura, 3))
    itens = d.get("items", [])
    if [it[0] for it in itens] == ["re"] and not d.get("even_odd"):
        # Contorno do PDF é centrado na borda; a borda do editor é por dentro da caixa —
        # cresce meia largura para cada lado para o traço cair no mesmo lugar.
        m = largura / 2 if stroke else 0
        return dict(type="rect", x=round(x0 - m, 2), y=round(y0 - m, 2),
                    w=round(x1 - x0 + 2 * m, 2), h=round(y1 - y0 + 2 * m, 2),
                    fill=fill or "transparent", **base)
    # Linha reta horizontal/vertical sem área: dá altura/largura mínima para o path existir.
    if x1 - x0 < 1e-3:
        x0, x1 = x0 - 0.5, x1 + 0.5
    if y1 - y0 < 1e-3:
        y0, y1 = y0 - 0.5, y1 + 0.5
    d_svg = path_d(itens, (x0, y0, x1, y1), bool(fill) or bool(d.get("closePath")))
    if d_svg is None:
        return None
    el = dict(type="path", x=round(x0, 2), y=round(y0, 2), w=round(x1 - x0, 2), h=round(y1 - y0, 2),
              fillPath=d_svg, fill=fill or "none", **base)
    if d.get("even_odd") and fill:
        el["fillRule"] = "evenodd"
    return el


# ----------------------------------------------------------------------------- gradientes

_TOKEN = re.compile(rb"\[|\]|<<|>>|/[^\s/\[\]<>(){}%]+|\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|%[^\n]*|[^\s/\[\]<>(){}%]+")


class RecursosSimples:
    """Recursos de um content stream para `usos_de_shading`: nome -> shading e nome -> Form
    XObject. Implementação em dicionário (testes); a do PDF de verdade fica no script."""
    def __init__(self, shadings=None, forms=None):
        self.shadings, self.forms = shadings or {}, forms or {}

    def shading(self, nome):
        return self.shadings.get(nome)

    def form(self, nome):
        return self.forms.get(nome)


def _mult(m, n):
    """m aplicado antes de n (convenção PDF: `cm` pré-multiplica o CTM)."""
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)


_PINTA = (b"n", b"f", b"F", b"f*", b"S", b"s", b"B", b"B*", b"b", b"b*")


def usos_de_shading(conteudo, recursos, ctm=(1, 0, 0, 1, 0, 0), recorte=None, profundidade=0):
    """Percorre um content stream rastreando q/Q/cm e o recorte (W/W*), ENTRANDO em Form
    XObjects (`/Nome Do`) com a /Matrix deles — o Canva agrupa elementos em forms, e um `sh`
    lá dentro não aparece no stream da página. Devolve, na ordem de pintura, um dict por `sh`:
    shading (o que `recursos.shading` devolveu), ctm, recorte = dict(bbox, path, retangular,
    evenodd) no espaço do PDF, ou None."""
    pilha, operandos, out = [], [], []
    caminho, sub = [], []          # path em construção (espaço do PDF, já com CTM)
    atual = None
    clip_pendente = None
    toks = _TOKEN.findall(conteudo)
    i = 0
    while i < len(toks):
        tok = toks[i]
        i += 1
        if tok.startswith(b"%"):
            continue
        num = lambda k: [float(v) for v in operandos[-k:]]
        try:
            if tok == b"q":
                pilha.append((ctm, recorte))
            elif tok == b"Q":
                ctm, recorte = pilha.pop() if pilha else (ctm, recorte)
            elif tok == b"cm" and len(operandos) >= 6:
                ctm = _mult(tuple(num(6)), ctm)
            elif tok == b"m" and len(operandos) >= 2:
                if sub:
                    caminho.append(sub)
                atual = _aplicar(ctm, num(2))
                sub = [("M", atual)]
            elif tok == b"l" and len(operandos) >= 2:
                atual = _aplicar(ctm, num(2))
                sub.append(("L", atual))
            elif tok in (b"c", b"v", b"y"):
                n = num(6 if tok == b"c" else 4)
                pts = [_aplicar(ctm, n[k:k + 2]) for k in range(0, len(n), 2)]
                if tok == b"v":
                    pts = [atual] + pts
                elif tok == b"y":
                    pts = [pts[0], pts[1], pts[1]]
                atual = pts[-1]
                sub.append(("C", *pts))
            elif tok == b"re" and len(operandos) >= 4:
                x, y, w, h = num(4)
                if sub:
                    caminho.append(sub)
                cantos = [_aplicar(ctm, p) for p in ((x, y), (x + w, y), (x + w, y + h), (x, y + h))]
                caminho.append([("M", cantos[0])] + [("L", c) for c in cantos[1:]] + [("Z",)])
                sub, atual = [], cantos[0]
            elif tok == b"h":
                sub.append(("Z",))
            elif tok in (b"W", b"W*"):
                clip_pendente = tok == b"W*"
            elif tok in _PINTA:
                if clip_pendente is not None:
                    todos = caminho + ([sub] if sub else [])
                    pts = [seg[k] for s_ in todos for seg in s_ for k in range(1, len(seg))]
                    if pts:
                        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                        bbox = (min(xs), min(ys), max(xs), max(ys))
                        ret = len(todos) == 1 and _e_retangulo(todos[0])
                        if recorte:
                            r0 = recorte["bbox"]
                            bbox = (max(r0[0], bbox[0]), max(r0[1], bbox[1]), min(r0[2], bbox[2]), min(r0[3], bbox[3]))
                            # Recorte não retangular anterior continua valendo se o novo é só uma caixa.
                            if ret and not recorte["retangular"]:
                                recorte = dict(recorte, bbox=bbox)
                                clip_pendente, caminho, sub = None, [], []
                                operandos = []
                                continue
                        recorte = dict(bbox=bbox, path=todos, retangular=ret, evenodd=bool(clip_pendente))
                clip_pendente, caminho, sub = None, [], []
            elif tok == b"sh" and operandos and operandos[-1].startswith(b"/"):
                # Sempre um item por `sh` (mesmo sem shading resolvido): a lista casa por posição
                # com as entradas "fill-shade" do bboxlog.
                out.append(dict(shading=recursos.shading(operandos[-1][1:].decode("latin1")), ctm=ctm, recorte=recorte))
            elif tok == b"Do" and operandos and operandos[-1].startswith(b"/") and profundidade < 8:
                form = recursos.form(operandos[-1][1:].decode("latin1"))
                if form:
                    stream, matriz, sub_recursos = form
                    out += usos_de_shading(stream, sub_recursos, _mult(matriz, ctm), recorte, profundidade + 1)
            elif tok == b"BI":  # imagem inline: pula até EI
                while i < len(toks) and toks[i] != b"EI":
                    i += 1
                i += 1
        except (ValueError, IndexError, TypeError):
            pass
        if re.fullmatch(rb"[A-Za-z'\"*]+", tok) and tok not in (b"true", b"false", b"null"):
            operandos = []
        else:
            operandos.append(tok)
    return out


def _e_retangulo(sub):
    """Subpath de 4 cantos com lados alinhados aos eixos (o `re` típico)."""
    pts = [seg[1] for seg in sub if seg[0] in ("M", "L")]
    if any(seg[0] == "C" for seg in sub) or len(pts) not in (4, 5):
        return False
    pts = pts[:4]
    xs = sorted({round(p[0], 2) for p in pts})
    ys = sorted({round(p[1], 2) for p in pts})
    return len(xs) == 2 and len(ys) == 2


def recorte_para_path(recorte, pagina_m, caixa):
    """Path do recorte (espaço do PDF) -> `d` de SVG normalizado 0..1 dentro de `caixa`
    (coordenadas de página) — o formato de `El.fillPath`."""
    x0, y0, x1, y1 = caixa
    w, h = (x1 - x0) or 1, (y1 - y0) or 1
    def n(p):
        q = _aplicar(pagina_m, p)
        return f"{(q[0] - x0) / w:.5f},{(q[1] - y0) / h:.5f}"
    partes = []
    for sub_ in recorte["path"]:
        for seg in sub_:
            if seg[0] == "M":
                partes.append("M" + n(seg[1]))
            elif seg[0] == "L":
                partes.append("L" + n(seg[1]))
            elif seg[0] == "C":
                partes.append(f"C{n(seg[1])} {n(seg[2])} {n(seg[3])}")
            else:
                partes.append("Z")
    return " ".join(partes)


def caixa_do_gradiente(bbox_log, recorte, pagina_m, pagina_rect):
    recorte = recorte["bbox"] if isinstance(recorte, dict) else recorte
    """Área em que o gradiente aparece de verdade (coordenadas de página): a caixa do bboxlog
    (que para `sh` costuma ser o plano infinito) ∩ recorte ativo ∩ página."""
    x0, y0, x1, y1 = bbox_log
    caixas = [(x0, y0, x1, y1), pagina_rect]
    if recorte:
        cantos = [_aplicar(pagina_m, p) for p in ((recorte[0], recorte[1]), (recorte[2], recorte[3]),
                                                   (recorte[0], recorte[3]), (recorte[2], recorte[1]))]
        caixas.append((min(c[0] for c in cantos), min(c[1] for c in cantos),
                       max(c[0] for c in cantos), max(c[1] for c in cantos)))
    r = (max(c[0] for c in caixas), max(c[1] for c in caixas), min(c[2] for c in caixas), min(c[3] for c in caixas))
    return r if r[2] - r[0] > 0.5 and r[3] - r[1] > 0.5 else None


def _numeros(s):
    return [float(v) for v in re.findall(r"-?\d*\.?\d+(?:[eE]-?\d+)?", s or "")]


def _refs(s):
    return [int(v) for v in re.findall(r"(\d+)\s+0\s+R", s or "")]


def paradas_da_funcao(get, fx):
    """Paradas [(cor_hex, posição 0..1)] de uma função de shading. `get(xref, chave)` devolve
    o valor bruto (string) de uma chave do objeto `xref`."""
    tipo = int((_numeros(get(fx, "FunctionType")) or [2])[0])
    if tipo == 2:
        c0 = _numeros(get(fx, "C0")) or [0.0]
        c1 = _numeros(get(fx, "C1")) or [1.0]
        return [(_rgb_hex(c0), 0.0), (_rgb_hex(c1), 1.0)]
    if tipo == 3:
        filhas = _refs(get(fx, "Functions"))
        dominio = _numeros(get(fx, "Domain")) or [0.0, 1.0]
        d0, d1 = dominio[0], dominio[-1]
        cortes = [d0] + _numeros(get(fx, "Bounds")) + [d1]
        paradas = []
        for i, f in enumerate(filhas):
            sub = paradas_da_funcao(get, f)
            a, b = cortes[i], cortes[i + 1] if i + 1 < len(cortes) else d1
            for cor, t in sub:
                pos = (a + (b - a) * t - d0) / ((d1 - d0) or 1)
                if not paradas or abs(paradas[-1][1] - pos) > 1e-4 or paradas[-1][0] != cor:
                    paradas.append((cor, round(pos, 4)))
        return paradas
    return []


def _aplicar(m, p):
    a, b, c, d, e, f = m
    return (a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f)


def gradiente_css(tipo, coords, ctm, pagina_m, caixa, paradas):
    """Gradiente no formato `Gradient` do editor + string CSS, com as paradas remapeadas para
    a linha de gradiente que o CSS usa dentro de `caixa` (x0,y0,x1,y1 em coordenadas de
    página). `pagina_m` converte do espaço do PDF para página (y para baixo)."""
    x0, y0, x1, y1 = caixa
    if tipo == 3:
        g = dict(type="radial", stops=[[c, p] for c, p in paradas])
        css = "radial-gradient(" + ", ".join(f"{c} {p * 100:.1f}%" for c, p in paradas) + ")"
        return g, css
    p0 = _aplicar(pagina_m, _aplicar(ctm, coords[0:2]))
    p1 = _aplicar(pagina_m, _aplicar(ctm, coords[2:4]))
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    if math.hypot(dx, dy) < 1e-6:
        dx, dy = 0.0, 1.0
    ang = math.degrees(math.atan2(dx, -dy)) % 360  # CSS: 0deg para cima, horário
    a = math.radians(ang)
    w, h = x1 - x0, y1 - y0
    comp = abs(w * math.sin(a)) + abs(h * math.cos(a)) or 1.0
    ux, uy = math.sin(a), -math.cos(a)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    inicio = (cx - ux * comp / 2, cy - uy * comp / 2)
    t = lambda p: ((p[0] - inicio[0]) * ux + (p[1] - inicio[1]) * uy) / comp
    t0, t1 = t(p0), t(p1)
    stops = [[c, round(t0 + (t1 - t0) * p, 4)] for c, p in paradas]
    g = dict(type="linear", angle=round(ang, 2), stops=stops)
    css = f"linear-gradient({ang:.2f}deg, " + ", ".join(f"{c} {p * 100:.2f}%" for c, p in stops) + ")"
    return g, css
