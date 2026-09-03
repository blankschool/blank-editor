#!/usr/bin/env python3
"""
Semeia no registry as fontes do PRÓPRIO APP — as famílias que o seletor do editor oferece
(`FONTS` em src/editor.ts) e que os modelos de partida usam.

Por que existe: o renderer roda com `loadSystemFonts: false`, então nada instalado na máquina
influencia o desenho. É a propriedade que se quer, mas significa que uma família não registrada
não desenha nada. Um design que usa "Inter" precisa que Inter exista no registry, igual a uma
fonte vinda de PDF — mesmo caminho, mesmo cache, mesma tabela.

Escreve DIRETO no Supabase (service-role), não pela API do app, e isso é deliberado: seria um
ovo-e-galinha registrar fontes através de um servidor que precisa de fontes para funcionar. Com
a escrita direta dá para semear ANTES do deploy, que é a ordem certa.

    python3 -m venv .venv && .venv/bin/pip install fonttools brotli
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... BLANK_OWNER_ID=<uuid> \
      .venv/bin/python scripts/seed-app-fonts.py

Idempotente: `on_conflict` em (owner_id, sha256), e o upload usa upsert.
"""
import hashlib, io, json, os, re, sys, urllib.error, urllib.request, uuid
from fontTools.ttLib import TTFont, TTCollection

URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
OWNER = os.environ.get("BLANK_OWNER_ID")

# Espelha `FONTS` em src/editor.ts, com os pesos que index.html carrega do Google Fonts. Manter
# os dois lados em sincronia é manual: família no seletor sem linha aqui vira erro de render.
FAMILIAS = {
    "Inter": [400, 500, 600, 700],
    "Montserrat": [300, 400, 500, 600, 700],
    "Space Grotesk": [400, 500, 600, 700],
    "Playfair Display": [400, 700],
    "Lora": [400, 700],
    "Oswald": [400, 600],
    "Bebas Neue": [400],
    "DM Serif Display": [400],
    "Caveat": [400, 700],
}

STRETCH = ["ultra-condensed", "extra-condensed", "condensed", "semi-condensed", "normal",
           "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"]


def http(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def ttf_do_google(familia, peso):
    # Sem User-Agent de browser o Google devolve woff2; queremos o TTF para gerar os dois.
    st, css = http(f"https://fonts.googleapis.com/css2?family={familia.replace(' ', '+')}:wght@{peso}",
                   headers={"User-Agent": "Mozilla/5.0"})
    urls = re.findall(r"url\((https://[^)]+\.ttf)\)", css.decode())
    if not urls:
        raise RuntimeError("nenhum .ttf no CSS do Google")
    return http(urls[0])[1]


def _serializa_estavel(fonte):
    """Serializa zerando os carimbos de tempo do `head`.

    Sem isso o fontTools grava a hora do save, e o mesmo arquivo produz um sha256 diferente a
    cada execução — o que faz o seed criar linha nova em vez de deduplicar, e duas faces da
    mesma família/peso no registry viram render recusado por ambiguidade. Foi exatamente o que
    aconteceu ao rodar este script duas vezes.
    """
    fonte["head"].created = fonte["head"].modified = 0
    buf = io.BytesIO(); fonte.save(buf)
    return buf.getvalue()


def faces_do_arquivo(dados):
    """Cada face como (bytes do SFNT, TTFont).

    Para um arquivo de face única devolve os BYTES ORIGINAIS, sem reserializar: é lossless e,
    principalmente, determinístico — o sha256 é o do arquivo que o Google publicou.

    Uma coleção (.ttc/.otc) precisa ser separada, e aí a serialização é nossa: nunca se envia a
    coleção inteira, porque browser e renderer têm que receber a mesma face lógica e depender de
    um índice dentro de um arquivo com várias fontes é frágil.
    """
    if dados[:4] == b"ttcf":
        for fonte in TTCollection(io.BytesIO(dados)).fonts:
            bytes_face = _serializa_estavel(fonte)
            yield bytes_face, TTFont(io.BytesIO(bytes_face))
    else:
        yield dados, TTFont(io.BytesIO(dados))


def sobe(bucket, caminho, conteudo, tipo):
    st, body = http(f"{URL}/storage/v1/object/{bucket}/{caminho}", data=conteudo,
                    headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
                             "Content-Type": tipo, "x-upsert": "true"}, method="POST")
    if st not in (200, 201):
        raise RuntimeError(f"upload {bucket}/{caminho}: HTTP {st} {body[:200]}")


def registra(sfnt, fonte, familia_pedida):
    sha = hashlib.sha256(sfnt).hexdigest()
    fonte.flavor = "woff2"
    woff2_buf = io.BytesIO(); fonte.save(woff2_buf)
    woff2 = woff2_buf.getvalue()

    o, nome = fonte["OS/2"], fonte["name"]

    # A família registrada é a que o rasterizador vai casar com o `font-family` do SVG, e o SVG
    # traz o que o editor gravou em `El.font` — o nome do seletor.
    #
    # Confere contra os DOIS nomes, como o servidor faz (fonts/sfntNames.ts). Num peso fora do
    # par regular/bold o Google entrega name ID 1 = "Inter Medium" (nome legado, que embute o
    # estilo) e name ID 16 = "Inter" (nome tipográfico). Olhar só o ID 1 rejeitaria metade das
    # faces por engano — foi o que aconteceu na primeira execução.
    nomes = {n for n in (nome.getDebugName(1), nome.getDebugName(16)) if n}
    chave = lambda x: x.replace(" ", "").lower()
    if not any(chave(n) == chave(familia_pedida) for n in nomes):
        raise RuntimeError(f"nenhum nome interno {sorted(nomes)} bate com '{familia_pedida}' — o render não casaria")

    sobe("font-sfnt", f"{sha}.ttf", sfnt, "font/ttf")
    sobe("fonts", f"{sha}.woff2", woff2, "font/woff2")

    linha = {
        "id": str(uuid.uuid4()), "owner_id": OWNER, "sha256": sha,
        "internal_family": familia_pedida, "postscript_name": nome.getDebugName(6),
        "weight": o.usWeightClass or 400, "style": nome.getDebugName(2) or "Regular",
        "stretch": STRETCH[min(max(o.usWidthClass, 1), 9) - 1], "os2_fs_type": int(o.fsType),
        "sfnt_path": f"supabase://font-sfnt/{sha}.ttf",
        "woff2_path": f"{URL}/storage/v1/object/public/fonts/{sha}.woff2",
    }
    st, body = http(f"{URL}/rest/v1/font_faces?on_conflict=owner_id,sha256",
                    data=json.dumps(linha).encode(),
                    headers={"apikey": KEY, "Authorization": f"Bearer {KEY}",
                             "Content-Type": "application/json",
                             "Prefer": "resolution=merge-duplicates,return=minimal"}, method="POST")
    if st not in (200, 201, 204):
        raise RuntimeError(f"insert: HTTP {st} {body[:300]}")
    return sha, int(o.fsType)


def main():
    if not (URL and KEY and OWNER):
        sys.exit("defina SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e BLANK_OWNER_ID")
    ok = falhas = 0
    for familia, pesos in FAMILIAS.items():
        for peso in pesos:
            try:
                for sfnt, fonte in faces_do_arquivo(ttf_do_google(familia, peso)):
                    sha, fs_type = registra(sfnt, fonte, familia)
                    aviso = "  [embedding restrito]" if fs_type & 0x000E else ""
                    print(f"  {familia:20} {peso:3}  {sha[:16]}{aviso}")
                    ok += 1
            except Exception as e:
                print(f"  {familia:20} {peso:3}  FALHOU: {e}", file=sys.stderr)
                falhas += 1
    print(f"\n{ok} faces registradas, {falhas} falhas")
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main())
