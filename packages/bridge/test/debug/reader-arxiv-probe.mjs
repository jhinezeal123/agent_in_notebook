// ER-0 (easy-read): how usable is arXiv's HTML (LaTeXML) for the reader?
// For each paper: arxiv.org/html/<id>, else ar5iv; counts what the reader
// needs (sections, paragraphs, equations with their TeX, figures, tables,
// algorithms, references) and what breaks it (LaTeXML error marks).
// Requests are sequential, 3 s apart (arXiv's terms). Not part of the test suite.
//
//   node packages/bridge/test/debug/reader-arxiv-probe.mjs [id…] [--out file.json]

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECENT = [
  "2312.00752", // Mamba
  "2401.04088", // Mixtral
  "2402.17764", // BitNet b1.58
  "2403.03206", // SD3 rectified flow
  "2404.19756", // KAN
  "2405.04434", // DeepSeek-V2
  "2405.21060", // Mamba-2
  "2409.12191", // Qwen2-VL
  "2410.05258", // Differential Transformer
  "2501.12948", // DeepSeek-R1
];
const OLDER = ["1706.03762", "1512.03385", "2006.11239", "2010.11929", "1707.06347", "2106.09685"];

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : join(tmpdir(), "reader-arxiv-probe.json");
const ids = args.filter((a, i) => !a.startsWith("--") && i !== outAt + 1);
const papers = ids.length ? ids : [...RECENT, ...OLDER];

const UA = { "user-agent": "agent-in-notebook reader probe (personal use)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function get(url) {
  const wait = last + 3100 - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(60_000) });
    const text = r.ok ? await r.text() : "";
    return { status: r.status, url: r.url, text, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, url, text: "", ms: Date.now() - t0, error: e.message };
  }
}

const count = (s, re) => (s.match(re) ?? []).length;

function analyse(html) {
  const body = html.slice(html.indexOf("<body"));
  const maths = [...body.matchAll(/<math\b[^>]*>/g)].map((m) => m[0]);
  const withTex = maths.filter((m) => /\balttext="/.test(m)).length;
  const errors = [...body.matchAll(/<[^>]*class="[^"]*\bltx_ERROR\b[^"]*"[^>]*>([^<]{0,60})/g)].map((m) => m[1].trim());
  const errorKinds = {};
  for (const e of errors) errorKinds[e] = (errorKinds[e] ?? 0) + 1;
  const imgs = [...body.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("/static/"));
  const classes = {};
  for (const m of body.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c.startsWith("ltx_")) classes[c] = (classes[c] ?? 0) + 1;
  return {
    bytes: html.length,
    title: (body.match(/<h1 class="ltx_title ltx_title_document">([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 80),
    sections: count(body, /<section[^>]*class="ltx_section"/g),
    subsections: count(body, /<section[^>]*class="ltx_subsection"/g),
    appendices: count(body, /<section[^>]*class="ltx_appendix"/g),
    paragraphs: count(body, /<div[^>]*class="ltx_para[ "][^>]*id="/g) + count(body, /<div[^>]*id="[^"]+"[^>]*class="ltx_para[ "]/g),
    equations: count(body, /class="ltx_equation[ "]/g) + count(body, /class="ltx_equationgroup[ "]/g),
    numberedEqIds: count(body, /id="[A-Za-z0-9.]+\.E\d+"/g),
    maths: maths.length,
    mathTexShare: maths.length ? +(withTex / maths.length).toFixed(3) : null,
    figures: count(body, /<figure[^>]*class="ltx_figure/g),
    tables: count(body, /<figure[^>]*class="ltx_table/g),
    algorithms: count(body, /class="ltx_float ltx_algorithm|class="ltx_listing/g),
    images: imgs.length,
    imagesRelative: imgs.filter((s) => !/^https?:/.test(s)).length,
    imageExamples: imgs.slice(0, 2),
    bibitems: count(body, /class="ltx_bibitem"/g),
    errors: errors.length,
    errorKinds: Object.fromEntries(Object.entries(errorKinds).sort((a, b) => b[1] - a[1]).slice(0, 6)),
    conversionWarning: /ltx_document_warning|Conversion errors have been found|HTML conversions sometimes display errors/i.test(body),
    topClasses: Object.fromEntries(Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 25)),
  };
}

const results = [];
for (const id of papers) {
  const meta = await get(`https://export.arxiv.org/api/query?id_list=${id}`);
  const title = (meta.text.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] ?? "?").replace(/\s+/g, " ").trim();
  let row = { id, title, source: "none" };
  for (const [source, url] of [["arxiv-html", `https://arxiv.org/html/${id}`], ["ar5iv", `https://ar5iv.labs.arxiv.org/html/${id}`]]) {
    const r = await get(url);
    // A failed conversion still answers 200: arxiv.org gives an empty "Untitled Document", ar5iv one
    // image per PDF page (PPO, 1707.06347, whose "source" only \includepdf's a PDF). Want real text.
    const isPaper = r.status === 200 && /class="ltx_page_main|class="ltx_document/.test(r.text)
      && (count(r.text, /<section[^>]*class="ltx_section"/g) >= 1 || count(r.text, /<math\b/g) >= 10);
    row[source] = { status: r.status, ms: r.ms, final: r.url, ...(r.error ? { error: r.error } : {}) };
    if (isPaper) {
      row = { ...row, source, ...analyse(r.text) };
      break;
    }
  }
  results.push(row);
  const s = row.source === "none" ? "NO HTML" : `${row.source} ${Math.round(row.bytes / 1024)}KB sec=${row.sections}/${row.subsections} para=${row.paragraphs} eq=${row.equations} math=${row.maths} tex=${row.mathTexShare} fig=${row.figures} tab=${row.tables} alg=${row.algorithms} err=${row.errors}`;
  console.log(`${id}  ${title.slice(0, 50).padEnd(50)}  ${s}`);
}
writeFileSync(out, JSON.stringify(results, null, 2));
console.log(`\nwrote ${out}`);
