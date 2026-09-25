"""Testes de pdf_shapes.py sem PyMuPDF. Rodar: python3 -m unittest test_pdf_shapes"""
import unittest

import pdf_shapes as S

PAGINA = (0, 0, 100, 100)


class Formas(unittest.TestCase):
    def test_retangulo_com_contorno_centrado(self):
        el = S.desenho_para_elemento(dict(type="fs", fill=(1, 0, 0), color=(0, 0, 1), width=4,
                                          rect=(10, 10, 30, 20), items=[("re", (10, 10, 30, 20))], seqno=3), PAGINA)
        self.assertEqual((el["type"], el["x"], el["w"], el["fill"], el["stroke"], el["strokeWidth"], el["z"]),
                         ("rect", 8, 24, "#ff0000", "#0000ff", 4, 3))

    def test_linha_so_contorno_vira_path_sem_fill(self):
        el = S.desenho_para_elemento(dict(type="s", color=(0, 0, 0), width=2, rect=(0, 50, 80, 50),
                                          items=[("l", (0, 50), (80, 50))]), PAGINA)
        self.assertEqual(el["type"], "path")
        self.assertEqual(el["fill"], "none")
        self.assertNotIn("Z", el["fillPath"])

    def test_even_odd_preservado_e_subpaths_separados(self):
        itens = [("l", (10, 10), (20, 10)), ("l", (20, 10), (20, 20)), ("l", (12, 12), (18, 12)), ("l", (18, 12), (18, 18))]
        el = S.desenho_para_elemento(dict(type="f", fill=(0, 0, 0), even_odd=True, rect=(10, 10, 20, 20), items=itens), PAGINA)
        self.assertEqual(el["fillRule"], "evenodd")
        self.assertEqual(el["fillPath"].count("M"), 2)

    def test_fundo_de_pagina_ignorado(self):
        self.assertIsNone(S.desenho_para_elemento(dict(type="f", fill=(1, 1, 1), rect=PAGINA, items=[("re", PAGINA)]), PAGINA))


class Gradientes(unittest.TestCase):
    def test_funcao_costurada(self):
        objs = {1: dict(FunctionType="3", Functions="[2 0 R 3 0 R]", Bounds="[0.5]", Domain="[0 1]"),
                2: dict(FunctionType="2", C0="[1 0 0]", C1="[0 1 0]"),
                3: dict(FunctionType="2", C0="[0 1 0]", C1="[0 0 1]")}
        paradas = S.paradas_da_funcao(lambda x, k: objs[x].get(k), 1)
        self.assertEqual(paradas, [("#ff0000", 0.0), ("#00ff00", 0.5), ("#0000ff", 1.0)])

    def test_axial_vertical_de_cima_para_baixo(self):
        # espaço do PDF (y para cima) -> página (y para baixo) em página de 100pt
        pagina_m = (1, 0, 0, -1, 0, 100)
        g, css = S.gradiente_css(2, [0, 100, 0, 0], (1, 0, 0, 1, 0, 0), pagina_m, (0, 0, 50, 100),
                                 [("#000000", 0.0), ("#ffffff", 1.0)])
        self.assertAlmostEqual(g["angle"], 180)
        self.assertEqual([p for _, p in g["stops"]], [0.0, 1.0])
        self.assertTrue(css.startswith("linear-gradient(180.00deg"))

    def test_ctm_do_content_stream(self):
        usos = S.matrizes_dos_sh(b"q 2 0 0 2 10 20 cm /Sh1 sh Q /Sh2 sh")
        self.assertEqual(usos, [("Sh1", (2.0, 0.0, 0.0, 2.0, 10.0, 20.0), None), ("Sh2", (1, 0, 0, 1, 0, 0), None)])

    def test_recorte_limita_o_gradiente(self):
        usos = S.matrizes_dos_sh(b"q 50 100 400 150 re W n /Sh1 sh Q")
        self.assertEqual(usos[0][2], (50.0, 100.0, 450.0, 250.0))
        caixa = S.caixa_do_gradiente((-1e9, -1e9, 1e9, 1e9), usos[0][2], (1, 0, 0, -1, 0, 800), (0, 0, 500, 800))
        self.assertEqual(caixa, (50.0, 550.0, 450.0, 700.0))


if __name__ == "__main__":
    unittest.main()
