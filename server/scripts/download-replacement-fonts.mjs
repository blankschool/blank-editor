import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { replacementFontFiles } from "../src/render/replacementFonts.ts";

const revision = "8e44913e4ff26fc997e6856c1ec40ff4791c98c5";
const base = `https://raw.githubusercontent.com/google/fonts/${revision}/ofl`;
const directory = new URL("../src/render/fonts/complete/", import.meta.url);
await mkdir(directory, { recursive: true });
async function download(url, filename) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  await writeFile(new URL(filename, directory), Buffer.from(await response.arrayBuffer()));
}
for (const file of new Set(replacementFontFiles.map(f => f.file))) {
  const family = file.split("-")[0];
  let upstream = file;
  if (family === "Arimo") upstream = file.includes("Italic") ? "Arimo-Italic[wght].ttf" : "Arimo[wght].ttf";
  if (family === "Inter") upstream = file.includes("Italic") ? "Inter-Italic[opsz,wght].ttf" : "Inter[opsz,wght].ttf";
  await download(`${base}/${family.toLowerCase()}/${encodeURIComponent(upstream)}`, file);
}
for (const family of new Set(replacementFontFiles.map(f => f.file.split("-")[0]))) {
  const url = family === "Tinos"
    ? "https://raw.githubusercontent.com/googlefonts/tinos/3b4482a99b80ea5fc75f187b1be3120a3f5905b3/OFL.txt"
    : `${base}/${family.toLowerCase()}/OFL.txt`;
  await download(url, `${family}-OFL.txt`);
}
console.log(`Complete font files and licenses downloaded to ${fileURLToPath(directory)}`);
