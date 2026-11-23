// Open a paper the way easy-read does, against the real arXiv, into a folder
// of your choice (not your Mentor shelf). Prints the reading view and the
// files kept. Polite: one request a second. The sources are TypeScript with
// .js specifiers, so bundle first (from packages/bridge):
//   npx esbuild test/debug/reader-open.mjs --bundle --platform=node --format=esm --outfile=<tmp>/reader-open.mjs \
//     --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
//   node <tmp>/reader-open.mjs <arxiv id or link> <folder>

const [, , source, root] = process.argv;
if (!source || !root) {
  console.error("usage: node reader-open.mjs <arxiv id or link> <folder>");
  process.exit(2);
}
const { ReaderHub } = await import("../../src/reader/index.ts");
const { readdirSync, statSync } = await import("node:fs");
const { join } = await import("node:path");

const hub = new ReaderHub({
  root,
  shelf: { paperFor: () => undefined, arxivOf: () => undefined, shelve: (p) => console.log(`shelve ${p.id}: ${p.kind}, ${p.source.length} chars`) },
  emit: (event, params) => console.log("event", event, JSON.stringify(params).slice(0, 120)),
  log: (m) => console.log(m),
});
const t0 = Date.now();
const view = await hub.open({ arxiv: source });
console.log(`opened in ${Date.now() - t0} ms`);
console.log({ ...view, sections: view.sections.length, notes: view.notes.length });
console.log(view.sections.slice(0, 12).map((s) => `${"  ".repeat(s.level - 1)}${s.id} ${s.number ?? ""} ${s.title} (~${s.minutes}′)${s.empty ? " [empty]" : ""}`).join("\n"));
const list = (dir, prefix = "") => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) list(full, `${prefix}${name}/`);
    else console.log(`  ${prefix}${name}  ${statSync(full).size} B`);
  }
};
list(view.dir);
console.log(hub.text(view.paperId, view.sections.find((s) => s.number === "4.1")?.id ?? view.sections[1]?.id).slice(0, 1200));
