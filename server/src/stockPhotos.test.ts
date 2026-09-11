import { test } from "node:test";
import assert from "node:assert/strict";
import { createStockPhotoLibrary } from "./stockPhotos.ts";

const foto = (id: number) => ({
  id, width: 4000, height: 6000, alt: `foto ${id}`, url: `https://www.pexels.com/photo/${id}/`,
  photographer: "Ana Fotógrafa",
  src: { original: "https://img/o.jpg", large2x: "https://img/l2x.jpg", medium: "https://img/m.jpg" },
});

const respostaJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("a busca manda a chave no header e devolve só o que o painel usa", async () => {
  const chamadas: Array<{ url: string; auth: unknown }> = [];
  const lib = createStockPhotoLibrary("chave-secreta", {
    fetchJson: async (url, init) => {
      chamadas.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization });
      return respostaJson({ photos: [foto(1), foto(2)], next_page: "https://api.pexels.com/v1/search?page=2" });
    },
  });

  const pagina = await lib.search("praia", { page: 2, orientation: "landscape" });
  assert.equal(chamadas[0].auth, "chave-secreta");
  assert.match(chamadas[0].url, /query=praia/);
  assert.match(chamadas[0].url, /page=2/);
  assert.match(chamadas[0].url, /orientation=landscape/);
  assert.deepEqual(pagina.photos[0], {
    id: "1", width: 4000, height: 6000, thumb: "https://img/m.jpg",
    alt: "foto 1", photographer: "Ana Fotógrafa", pageUrl: "https://www.pexels.com/photo/1/",
  });
  assert.equal(pagina.hasMore, true);
});

test("uma orientação inventada e uma página inválida não viram parâmetro", async () => {
  let url = "";
  const lib = createStockPhotoLibrary("k", {
    fetchJson: async (u) => { url = u; return respostaJson({ photos: [] }); },
  });
  await lib.search("gato", { page: -3, orientation: "diagonal" });
  assert.ok(!url.includes("orientation"), "orientação desconhecida não deve ir para o Pexels");
  assert.match(url, /page=1/);
});

test("busca vazia não chega a chamar o provedor", async () => {
  let chamou = false;
  const lib = createStockPhotoLibrary("k", { fetchJson: async () => { chamou = true; return respostaJson({}); } });
  assert.deepEqual(await lib.search("   "), { photos: [], hasMore: false });
  assert.equal(chamou, false);
});

test("uma foto sem miniatura é descartada em vez de virar uma grade quebrada", async () => {
  const lib = createStockPhotoLibrary("k", {
    fetchJson: async () => respostaJson({ photos: [{ id: 9, src: {} }, foto(3)] }),
  });
  const pagina = await lib.search("montanha");
  assert.deepEqual(pagina.photos.map((p) => p.id), ["3"]);
  assert.equal(pagina.hasMore, false);
});

test("o arquivo vem do large2x, e um id que não é número nunca chega ao provedor", async () => {
  let pedido = "";
  const lib = createStockPhotoLibrary("k", {
    fetchJson: async (url) => { pedido = url; return respostaJson(foto(7)); },
    fetchImageBytes: async (url) => Buffer.from(`bytes de ${url}`),
  });
  const arquivo = await lib.file("7");
  assert.match(pedido, /photos\/7/);
  assert.equal(arquivo.bytes.toString(), "bytes de https://img/l2x.jpg");
  assert.equal(arquivo.contentType, "image/jpeg");
  await assert.rejects(() => lib.file("7/../../admin"), /id de foto inválido/);
});

test("um erro do provedor sobe com o status, em vez de virar resultado vazio", async () => {
  const lib = createStockPhotoLibrary("k", { fetchJson: async () => respostaJson({ error: "no" }, 429) });
  await assert.rejects(() => lib.search("praia"), /respondeu 429/);
});
