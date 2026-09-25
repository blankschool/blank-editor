"""Testes do agrupamento/layout de pdf_layout.py com spans sintéticos no formato do
`page.get_texttrace()` — sem PyMuPDF. Rodar: python3 -m unittest scripts/test_pdf_layout.py"""
import math
import unittest

import pdf_layout as L


def span(texto, x, y, size=20, seqno=0, font="Sans-Regular", color=(0, 0, 0), adv=0.5, ang=0.0, opacity=1.0):
    c, s = math.cos(ang), math.sin(ang)
    chars = []
    u = 0.0
    for ch in texto:
        ox, oy = x + u * c, y + u * s
        w = adv * size
        chars.append((ord(ch), ord(ch), (ox, oy), (ox, oy - 0.8 * size, ox + w, oy + 0.2 * size)))
        u += w
    return dict(type=0, font=font, size=size, color=color, opacity=opacity, wmode=0, flags=0,
                ascender=0.8, descender=-0.2, seqno=seqno, dir=(c, s), chars=chars)


def estilo(span):
    fam, est = span["font"].split("-")
    return dict(font=fam, fontStyle=est, weight=700 if est == "Bold" else 400, italic=False)


natural = lambda span, gid: 0.5


def extrair(spans, nao_texto=()):
    linhas = L.agrupar_linhas(L.spans_visiveis(spans))
    pars = L.agrupar_paragrafos(linhas, set(nao_texto))
    return [L.paragrafo_para_elemento(p, estilo, natural) for p in pars]


class Layout(unittest.TestCase):
    def test_paragrafo_com_quebras_lh_e_posicao(self):
        els = extrair([span("Hello", 100, 200, seqno=1), span("World", 100, 230, seqno=2)])
        self.assertEqual(len(els), 1)
        el = els[0]
        self.assertEqual(el["text"], "Hello\nWorld")
        self.assertAlmostEqual(el["lh"], 1.5)
        self.assertEqual(el["z"], 1)
        # baseline da 1ª linha no modelo CSS: y + (L - (asc+desc)*size)/2 + asc*size == 200
        L_ = el["lh"] * el["size"]
        self.assertAlmostEqual(el["y"] + (L_ - 20) / 2 + 16, 200, places=1)
        self.assertAlmostEqual(el["x"], 100, places=1)
        self.assertAlmostEqual(el["h"], 2 * L_, places=1)

    def test_run_de_negrito_no_meio(self):
        els = extrair([span("Hello ", 0, 50, seqno=1), span("yo", 60, 50, seqno=2, font="Sans-Bold")])
        el = els[0]
        self.assertEqual(el["text"], "Hello yo")
        self.assertEqual(el["runs"], [dict(text="Hello "), dict(text="yo", weight=700)])
        self.assertEqual(el["weight"], 400)

    def test_objeto_nao_texto_entre_linhas_separa_paragrafos(self):
        els = extrair([span("A", 0, 50, seqno=1), span("B", 0, 80, seqno=3)], nao_texto=[2])
        self.assertEqual([e["z"] for e in els], [1, 3])

    def test_alinhamento_centralizado(self):
        els = extrair([span("abcdef", 100, 50, seqno=1), span("ab", 120, 80, seqno=2)])
        self.assertEqual(els[0]["align"], "center")

    def test_letter_spacing_medido(self):
        s = span("abcdef", 0, 50, seqno=1, adv=0.6)  # natural 0.5 -> +0.1*20 = 2pt por letra
        self.assertAlmostEqual(extrair([s])[0]["ls"], 2.0, places=2)

    def test_rotacao_horaria_e_centro_preservado(self):
        ang = math.radians(-30)
        el = extrair([span("Titulo", 100, 300, seqno=1, ang=ang)])[0]
        self.assertAlmostEqual(el["rot"], -30, places=1)

    def test_texto_invisivel_ignorado(self):
        s = span("ocr", 0, 0)
        s["type"] = 3
        self.assertEqual(extrair([s]), [])

    def test_espaco_inferido_por_deslocamento(self):
        els = extrair([span("Oi", 0, 50, seqno=1), span("la", 40, 50, seqno=2)])
        self.assertEqual(els[0]["text"], "Oi la")


if __name__ == "__main__":
    unittest.main()
