"""
Layout fiel de texto e ordem de pintura (z-order) de uma página de PDF, via PyMuPDF.

Por que `get_texttrace()` e não `get_text("dict")`: o trace devolve cada span com `seqno` —
o índice do span em `page.get_bboxlog()`, que é a ordem REAL em que o PDF pinta texto, forma e
imagem. Sem isso a ordem das camadas tinha que ser chutada (antes: sempre formas → imagens →
texto, o que punha texto atrás de foto na frente dela). O trace também traz opacidade,
ascender/descender e origem de cada caractere, que é o que permite reproduzir baseline,
entrelinha e espaçamento entre letras em vez de deixar o editor recalcular o layout.

O agrupamento em linhas/parágrafos é feito aqui (o trace não agrupa) — de propósito: o
agrupamento em blocos do `get_text("dict")` junta caixas de texto diferentes do Canva e não
respeita a ordem de pintura.

Modelo de texto do editor (editorText.ts / drawEl em editor.ts): caixa sem rotação x/y/w/h,
girada em torno do centro por `rot` (graus, horário); cada linha ocupa `lh * size`; o glifo
fica centrado na linha como no CSS (meia-entrelinha): baseline da linha i =
    y + i*L + (L - (asc+desc)*size)/2 + asc*size,   L = lh*size
Este módulo resolve `y` e `lh` a partir das baselines medidas no PDF.
"""
import math
from statistics import median

# Tipos de span do texttrace: 0 fill, 1 stroke, 2 clip, 3 invisível (OCR / texto oculto).
_INVISIVEL = 3


def _rgb_hex(color):
    if not color:
        return "#000000"
    if len(color) == 1:  # cinza
        color = (color[0],) * 3
    if len(color) == 4:  # CMYK -> RGB aproximado
        c, m, y, k = color
        color = ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(v * 255))) for v in color[:3])


def _angulo(span):
    """Ângulo do baseline em radianos, sentido horário (coordenadas de página com y para baixo,
    igual ao `rotate()` do canvas/CSS do editor). Calculado das ORIGENS dos caracteres, que é
    inequívoco; `dir` só entra quando o span tem um caractere só."""
    chars = span["chars"]
    if len(chars) >= 2:
        (x0, y0), (x1, y1) = chars[0][2], chars[-1][2]
        if math.hypot(x1 - x0, y1 - y0) > 1e-3:
            return math.atan2(y1 - y0, x1 - x0)
    dx, dy = span.get("dir", (1, 0))
    return math.atan2(dy, dx)


def _local(p, origem, ang):
    """Ponto de página -> frame local do baseline (u ao longo do texto, v para baixo)."""
    c, s = math.cos(ang), math.sin(ang)
    dx, dy = p[0] - origem[0], p[1] - origem[1]
    return dx * c + dy * s, -dx * s + dy * c


def _pagina(p, origem, ang):
    c, s = math.cos(ang), math.sin(ang)
    return origem[0] + p[0] * c - p[1] * s, origem[1] + p[0] * s + p[1] * c


def _fim_char(char, origem, ang):
    """Borda direita (no frame local) de um caractere, pelo canto mais à direita da bbox."""
    x0, y0, x1, y1 = char[3]
    return max(_local(q, origem, ang)[0] for q in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)))


def spans_visiveis(trace):
    out = []
    for span in trace:
        if span.get("type") == _INVISIVEL or not span.get("chars"):
            continue
        if (span.get("opacity") or 0) <= 0:
            continue
        if span.get("wmode", 0) != 0:  # texto vertical: fora do modelo do editor
            continue
        out.append(span)
    return out


def _mesmo_angulo(a, b, tol=math.radians(1.5)):
    d = abs(a - b) % (2 * math.pi)
    return min(d, 2 * math.pi - d) < tol


def agrupar_linhas(spans):
    """Spans consecutivos (na ordem de pintura) no mesmo baseline e mesma direção viram uma
    linha. Retorna lista de dicts {ang, origem, spans, baseline_local}."""
    linhas = []
    for span in spans:
        ang = _angulo(span)
        o = span["chars"][0][2]
        atual = linhas[-1] if linhas else None
        if atual and _mesmo_angulo(atual["ang"], ang):
            u, v = _local(o, atual["origem"], atual["ang"])
            fim = atual["fim"]
            tam = max(span["size"], atual["spans"][-1]["size"])
            if abs(v) < 0.2 * tam and -0.5 * tam < u - fim < 1.5 * tam:
                atual["spans"].append(span)
                atual["fim"] = max(fim, _fim_char(span["chars"][-1], atual["origem"], atual["ang"]))
                continue
        linhas.append(dict(ang=ang, origem=o, spans=[span],
                           fim=_fim_char(span["chars"][-1], o, ang)))
    return linhas


def _tamanho(linha):
    return max(s["size"] for s in linha["spans"])


def agrupar_paragrafos(linhas, seqnos_nao_texto):
    """Linhas consecutivas viram um parágrafo (uma caixa de texto editável) quando: mesma
    direção, mesmo tamanho de fonte (±6% — `runs` não suportam tamanho misto), passo de
    entrelinha coerente, sobreposição horizontal e NENHUM objeto não-texto pintado entre elas
    (senão juntar mudaria a ordem de camadas)."""
    paragrafos = []
    for linha in linhas:
        p = paragrafos[-1] if paragrafos else None
        if p and _cabe_no_paragrafo(p, linha, seqnos_nao_texto):
            p["linhas"].append(linha)
            continue
        paragrafos.append(dict(linhas=[linha]))
    return paragrafos


def _cabe_no_paragrafo(p, linha, seqnos_nao_texto):
    ultima = p["linhas"][-1]
    if not _mesmo_angulo(ultima["ang"], linha["ang"]):
        return False
    tam = _tamanho(ultima)
    if abs(_tamanho(linha) - tam) > 0.06 * tam:
        return False
    s0 = max(s["seqno"] for s in ultima["spans"])
    s1 = min(s["seqno"] for s in linha["spans"])
    if any(s0 < q < s1 for q in seqnos_nao_texto):
        return False
    base = p["linhas"][0]
    u, v = _local(linha["origem"], base["origem"], base["ang"])
    _, v_ult = _local(ultima["origem"], base["origem"], base["ang"])
    passo = v - v_ult
    if not (0.7 * tam < passo < 2.2 * tam):
        return False
    if len(p["linhas"]) >= 2:
        _, v_pen = _local(p["linhas"][-2]["origem"], base["origem"], base["ang"])
        if abs(passo - (v_ult - v_pen)) > 0.15 * tam:
            return False
    # sobreposição horizontal com o parágrafo
    ini_p = min(_local(l["origem"], base["origem"], base["ang"])[0] for l in p["linhas"])
    fim_p = max(_local(_pagina((l["fim"], 0), l["origem"], l["ang"]), base["origem"], base["ang"])[0] for l in p["linhas"])
    fim_l = _local(_pagina((linha["fim"], 0), linha["origem"], linha["ang"]), base["origem"], base["ang"])[0]
    return u < fim_p and fim_l > ini_p


def _texto_linha(linha):
    """Texto da linha, com os runs (trechos de estilo) — insere espaço quando o PDF posiciona
    palavras por deslocamento em vez de um caractere de espaço."""
    pedacos = []  # (texto, span)
    fim_ant = None
    o, ang = linha["origem"], linha["ang"]
    for span in linha["spans"]:
        for ch in span["chars"]:
            c = chr(ch[0]) if isinstance(ch[0], int) else ch[0]
            u = _local(ch[2], o, ang)[0]
            if fim_ant is not None and u - fim_ant > 0.22 * span["size"] and c != " " \
                    and not (pedacos and pedacos[-1][0].endswith(" ")):
                pedacos.append((" ", span))
            pedacos.append((c, span))
            fim_ant = _fim_char(ch, o, ang)
    return pedacos


def _letter_spacing(spans, avanco_natural):
    """Espaçamento extra por caractere (em pontos, mesma unidade do `size`): diferença mediana
    entre o avanço medido (origem do próximo char - origem deste) e o avanço natural do glifo
    na fonte. `avanco_natural(span, glyph_id)` devolve o avanço em em (0..1) ou None."""
    diffs = []
    for span in spans:
        chars = span["chars"]
        ang = _angulo(span)
        for a, b in zip(chars, chars[1:]):
            nat = avanco_natural(span, a[1])
            if nat is None:
                continue
            medido = _local(b[2], a[2], ang)[0]
            diffs.append(medido - nat * span["size"])
    if len(diffs) < 3:
        return 0.0
    ls = median(diffs)
    tam = max(s["size"] for s in spans)
    # Tracking real do Canva fica bem abaixo de 0.2em; acima disso o avanço "natural" veio de
    # métricas que não batem com o glifo (visto em produção: 0.58em num título sem tracking),
    # e aplicar faria a linha estourar a caixa e quebrar.
    if abs(ls) > 0.2 * tam:
        return 0.0
    return ls if abs(ls) > 0.01 * tam else 0.0


def _alinhamento(ini, fim, tam):
    if len(ini) < 2:
        return "left"
    tol = 0.15 * tam
    esp = lambda xs: max(xs) - min(xs)
    centros = [(a + b) / 2 for a, b in zip(ini, fim)]
    candidatos = [("left", esp(ini)), ("center", esp(centros)), ("right", esp(fim))]
    melhor, spread = min(candidatos, key=lambda c: c[1])
    if spread > tol and esp(ini) <= tol * 2:
        return "left"
    return melhor


def paragrafo_para_elemento(par, estilo_do_span, avanco_natural):
    """Converte um parágrafo no elemento de texto do editor (em pontos; orchestrate.ts escala).
    `estilo_do_span(span)` -> dict(font, weight, italic, fontStyle, fontOriginal?)."""
    linhas = par["linhas"]
    base = linhas[0]
    o, ang = base["origem"], base["ang"]
    tam = _tamanho(base)
    spans = [s for l in linhas for s in l["spans"]]

    asc = median(s.get("ascender", 0.9) for s in spans)
    desc = abs(median(s.get("descender", -0.2) for s in spans))
    if asc + desc <= 0:
        asc, desc = 0.9, 0.2

    baselines = [_local(l["origem"], o, ang)[1] for l in linhas]
    if len(baselines) >= 2:
        passo = median(b - a for a, b in zip(baselines, baselines[1:]))
    else:
        passo = (asc + desc) * tam * 1.0
    lh = passo / tam
    L = passo

    ini, fim = [], []
    for l in linhas:
        ini.append(_local(l["origem"], o, ang)[0])
        fim.append(_local(_pagina((l["fim"], 0), l["origem"], l["ang"]), o, ang)[0])
    align = _alinhamento(ini, fim, tam)

    x0, x1 = min(ini), max(fim)
    largura = x1 - x0
    # Folga para métricas levemente diferentes da fonte que o navegador vai usar não forçarem
    # uma quebra de linha que o PDF não tinha. Cresce para o lado que não quebra o alinhamento.
    folga = max(0.04 * largura, 0.5 * tam)
    if align == "left":
        x1 += folga
    elif align == "right":
        x0 -= folga
    else:
        x0 -= folga / 2
        x1 += folga / 2

    topo = baselines[0] - (L - (asc + desc) * tam) / 2 - asc * tam
    altura = L * len(linhas)
    w, h = x1 - x0, altura
    cx, cy = _pagina((x0 + w / 2, topo + h / 2), o, ang)

    # Runs: um por sequência de caracteres com o mesmo estilo; linhas separadas por "\n".
    runs = []  # [texto, span, (cor, fonte)]
    for i, l in enumerate(linhas):
        if i and runs:
            runs[-1][0] += "\n"
        for c, span in _texto_linha(l):
            chave = (_rgb_hex(span.get("color")), span["font"])
            if runs and runs[-1][2] == chave:
                runs[-1][0] += c
            else:
                runs.append([c, span, chave])
    texto = "".join(r[0] for r in runs)

    # Estilo principal = o que cobre mais caracteres.
    peso_chave = {}
    for r in runs:
        peso_chave[r[2]] = peso_chave.get(r[2], 0) + len(r[0].strip()) + 1e-3
    chave_principal = max(peso_chave, key=peso_chave.get)
    span_principal = next(r[1] for r in runs if r[2] == chave_principal)
    principal = estilo_do_span(span_principal)
    cor_principal = chave_principal[0]

    runs_saida = []
    for texto_run, span, chave in runs:
        run = dict(text=texto_run)
        if chave != chave_principal:
            est = estilo_do_span(span)
            if est["font"] != principal["font"]:
                run["font"] = est["font"]
                if est.get("fontOriginal"):
                    run["fontOriginal"] = est["fontOriginal"]
            if est["weight"] != principal["weight"]:
                run["weight"] = est["weight"]
            if est.get("italic") != principal.get("italic"):
                run["italic"] = bool(est.get("italic"))
            if chave[0] != cor_principal:
                run["fill"] = chave[0]
        runs_saida.append(run)
    tem_runs = any(len(r) > 1 for r in runs_saida)

    flags = span_principal.get("flags", 0)
    opacidade = max(s.get("opacity", 1) for s in spans)
    el = dict(
        type="text",
        x=round(cx - w / 2, 2), y=round(cy - h / 2, 2), w=round(w, 2), h=round(h, 2),
        text=texto,
        font=principal["font"],
        fontStyle=principal.get("fontStyle", "Regular"),
        fontCategory="mono" if flags & 8 else "serif" if flags & 4 else "sans",
        weight=principal["weight"],
        size=round(tam, 2),
        fill=cor_principal,
        rot=round(math.degrees(ang), 2),
        lh=round(lh, 4),
        ls=round(_letter_spacing(spans, avanco_natural), 3),
        align=align,
        opacity=round(opacidade, 3),
        z=min(s["seqno"] for s in spans),
    )
    if principal.get("fontOriginal"):
        el["fontOriginal"] = principal["fontOriginal"]
    if tem_runs:
        el["runs"] = runs_saida
    return el


def seqnos_de_imagens(page):
    """Ordem de pintura de cada imagem: `get_image_info` não traz seqno, mas lista as imagens
    na mesma ordem em que aparecem no content stream — igual à ordem das entradas
    "fill-image" do `get_bboxlog()`. Casa as duas listas por posição, conferindo a bbox."""
    log = page.get_bboxlog()
    entradas = [(i, r) for i, (tipo, r) in enumerate(log) if "image" in tipo]
    infos = page.get_image_info(xrefs=True)
    out = []
    for k, info in enumerate(infos):
        seq = entradas[k][0] if k < len(entradas) else None
        # confere; se não bater, procura a entrada de imagem com bbox mais próxima
        if seq is None or not _bbox_perto(entradas[k][1], info["bbox"]):
            melhor = min(entradas, key=lambda e: _dist_bbox(e[1], info["bbox"]), default=None)
            seq = melhor[0] if melhor else None
        if seq is not None:
            out.append(dict(bbox=[round(v, 2) for v in info["bbox"]], z=seq))
    return out


def seqnos_nao_texto(page):
    return {i for i, (tipo, _) in enumerate(page.get_bboxlog()) if "text" not in tipo}


def _dist_bbox(a, b):
    return sum(abs(p - q) for p, q in zip(a, b))


def _bbox_perto(a, b, tol=2.0):
    return _dist_bbox(a, b) < tol * 4
