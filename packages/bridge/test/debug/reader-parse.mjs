// Parse an arXiv HTML page saved on disk with the reader's parser and print what came out
// (sections, blocks, equations, figures). Not part of the test suite.
//
//   node packages/bridge/test/debug/reader-parse.mjs <page.html> <base-url> [out-dir]   (Node 23.6+: loads the .ts source as is)

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { docText, parseArxivHtml } = await import("../../src/reader/doc.ts");

const [file, base, out] = process.argv.slice(2);
if (!file || !base) {
  console.error("usage: reader-parse.mjs <page.html> <base-url> [out-dir]");
  process.exit(2);
}
const t0 = Date.now();
const p = parseArxivHtml(readFileSync(file, "utf8"), base);
console.log(`${p.title} — ${p.authors ?? "?"} (${Date.now() - t0} ms)`);
console.log(`sections ${p.sections.length}, blocks ${p.blocks.length}, equations ${p.equations.length}, refs ${p.refs.length}, assets ${p.assets.length}, html ${Math.round(p.html.length / 1024)} KB`);
for (const s of p.sections) console.log(`${"  ".repeat(s.level - 1)}${s.id.padEnd(12)} ${s.number ?? ""} ${s.title.slice(0, 60)} · ${s.blocks.length} blocks · ${s.minutes}′`);
console.log("kinds:", Object.entries(p.blocks.reduce((m, b) => ({ ...m, [b.kind]: (m[b.kind] ?? 0) + 1 }), {})));
console.log("equations:", p.equations.slice(0, 5));
console.log("figures:", p.blocks.filter((b) => b.kind === "fig").slice(0, 3));
console.log("assets:", p.assets.slice(0, 3));
console.log("warnings:", p.warnings);
if (out) {
  writeFileSync(join(out, "doc.html"), p.html);
  writeFileSync(join(out, "text.md"), docText(p));
  console.log(`wrote ${out}/doc.html and text.md`);
}
