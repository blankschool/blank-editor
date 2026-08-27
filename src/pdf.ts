/**
 * Minimal PDF writer: one JPEG per page, correct xref offsets.
 * A leaf module — no editor state reaches in here, which is what makes it the
 * safe place to swap in a real vector-PDF library later.
 */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export function buildPDF(pagesJpeg) {
  const enc = new TextEncoder();
  const objs = [];
  const add = (parts) => { objs.push(parts); return objs.length; };
  const kids = [];
  const catalog = 1, pagesObj = 2;
  objs.push(null, null); // reserve 1,2
  for (const pg of pagesJpeg) {
    const imgNo = add([enc.encode(`<</Type/XObject/Subtype/Image/Width ${pg.pw} /Height ${pg.ph} /ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${pg.bytes.length}>>\nstream\n`), pg.bytes, enc.encode("\nendstream")]);
    const content = `q ${pg.w} 0 0 ${pg.h} 0 0 cm /Im0 Do Q`;
    const contNo = add([enc.encode(`<</Length ${content.length}>>\nstream\n${content}\nendstream`)]);
    const pageNo = add([enc.encode(`<</Type/Page/Parent ${pagesObj} 0 R/MediaBox[0 0 ${pg.w} ${pg.h}]/Resources<</XObject<</Im0 ${imgNo} 0 R>>>>/Contents ${contNo} 0 R>>`)]);
    kids.push(pageNo);
  }
  objs[0] = [enc.encode(`<</Type/Catalog/Pages ${pagesObj} 0 R>>`)];
  objs[1] = [enc.encode(`<</Type/Pages/Kids[${kids.map((k) => k + " 0 R").join(" ")}]/Count ${kids.length}>>`)];

  const chunks = []; let len = 0;
  const push = (u) => { chunks.push(u); len += u.length; };
  push(enc.encode("%PDF-1.4\n"));
  const offs = [];
  objs.forEach((parts, i) => {
    offs[i] = len;
    push(enc.encode(`${i + 1} 0 obj\n`));
    parts.forEach(push);
    push(enc.encode("\nendobj\n"));
  });
  const xref = len;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) x += String(o).padStart(10, "0") + " 00000 n \n";
  x += `trailer\n<</Size ${objs.length + 1}/Root ${catalog} 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  push(enc.encode(x));

  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
