import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { renderPagePreview } from "./extractImages.ts";

function multipagePdf(): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    const stream = `${i === 0 ? "1 0 0" : "0 0 1"} rg 0 0 72 72 re f\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents ${page + 1} 0 R >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  objects[1] = `<< /Type /Pages /Count 12 /Kids [${kids.join(" ")}] >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("preview uses a stable filename and the requested page in a multi-digit PDF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-regression-"));
  try {
    const path = join(dir, "input.pdf");
    await writeFile(path, multipagePdf());
    await mkdir(join(dir, "pages"));
    for (const page of [1, 2, 12]) {
      const png = await renderPagePreview(path, page, join(dir, "pages"));
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 150);
      assert.equal(info.height, 150);
      assert.deepEqual([...data.subarray(0, 3)], page === 1 ? [255, 0, 0] : [0, 0, 255]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
