// ER-0 probe page, inside a VS Code webview (see runner.cjs). Every check
// posts a result; nothing here is product code.

const vscode = acquireVsCodeApi();
const P = window.PROBE;
const N = P.nonce;
const logEl = document.getElementById("log");

function result(name, ok, detail) {
  vscode.postMessage({ t: "result", name, ok, detail });
  const d = document.createElement("div");
  d.textContent = `${ok ? "OK  " : "NO  "} ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  logEl.append(d);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A sandboxed srcdoc frame; collects what it posts for `wait` ms. */
function frame(html, { sandbox = "allow-scripts", wait = 1500 } = {}) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    if (sandbox !== null) f.setAttribute("sandbox", sandbox);
    f.style.cssText = "width:300px;height:60px;border:1px solid #888";
    const msgs = [];
    const on = (e) => { if (e.source === f.contentWindow) msgs.push(e.data); };
    window.addEventListener("message", on);
    f.srcdoc = html;
    document.body.append(f);
    setTimeout(() => { window.removeEventListener("message", on); resolve({ msgs, f }); }, wait);
  });
}

/** Longest gap of a 20 ms interval while `during` runs: how blocked the page was. */
async function maxGap(during, ms) {
  let last = performance.now();
  let gap = 0;
  const id = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 20);
  await during();
  await sleep(ms);
  clearInterval(id);
  return Math.round(gap);
}

async function sandboxChecks() {
  const html = `<!doctype html><html><head><style>body{color:rgb(1,2,3)}</style></head><body>
<button id="b" onclick="parent.postMessage({kind:'inline-handler-ran'},'*')">b</button>
<script nonce="${N}">
  const r = { origin: String(self.origin) };
  try { r.parentDocument = typeof parent.document; } catch (e) { r.parentDocument = "blocked: " + e.name; }
  try { localStorage.getItem("x"); r.localStorage = "ok"; } catch (e) { r.localStorage = "blocked: " + e.name; }
  r.acquireVsCodeApi = typeof acquireVsCodeApi;
  try { r.eval = String(eval("1+1")); } catch (e) { r.eval = "blocked: " + e.name; }
  try { r.newFunction = String(new Function("return 2")()); } catch (e) { r.newFunction = "blocked: " + e.name; }
  try { r.windowOpen = String(window.open("https://arxiv.org/")); } catch (e) { r.windowOpen = "blocked: " + e.name; }
  r.style = getComputedStyle(document.body).color;
  const v = [];
  document.addEventListener("securitypolicyviolation", (e) => v.push(e.violatedDirective + " " + e.blockedURI));
  parent.postMessage({ kind: "ran", r }, "*");
  fetch("https://arxiv.org/").then(() => parent.postMessage({ kind: "fetch", v: "reached" }, "*"), (e) => parent.postMessage({ kind: "fetch", v: "blocked: " + e.message }, "*"));
  try { new WebSocket("wss://example.org/"); parent.postMessage({ kind: "ws", v: "created" }, "*"); } catch (e) { parent.postMessage({ kind: "ws", v: "blocked: " + e.name }, "*"); }
  const img = new Image();
  img.onload = () => parent.postMessage({ kind: "img", v: "loaded" }, "*");
  img.onerror = () => parent.postMessage({ kind: "img", v: "error" }, "*");
  img.src = "https://arxiv.org/favicon.ico";
  document.getElementById("b").click();
  setTimeout(() => parent.postMessage({ kind: "violations", v }, "*"), 900);
</script>
<script>parent.postMessage({ kind: "no-nonce-ran" }, "*");</script>
<script type="module" nonce="${N}">parent.postMessage({ kind: "module-ran" }, "*");</script>
</body></html>`;
  const { msgs } = await frame(html, { wait: 2000 });
  const by = (k) => msgs.find((m) => m.kind === k);
  const ran = by("ran");
  result("srcdoc+sandbox: nonce script runs", !!ran, ran ? ran.r : `messages: ${JSON.stringify(msgs)}`);
  if (!ran) return false;
  result("srcdoc: opaque origin", ran.r.origin === "null", ran.r.origin);
  result("srcdoc: cannot reach parent document", String(ran.r.parentDocument).startsWith("blocked"), ran.r.parentDocument);
  result("srcdoc: no storage", String(ran.r.localStorage).startsWith("blocked"), ran.r.localStorage);
  result("srcdoc: no VS Code API", ran.r.acquireVsCodeApi === "undefined", ran.r.acquireVsCodeApi);
  result("srcdoc: eval blocked (widget code must not use eval/new Function)", String(ran.r.eval).startsWith("blocked") && String(ran.r.newFunction).startsWith("blocked"), { eval: ran.r.eval, newFunction: ran.r.newFunction });
  result("srcdoc: popups blocked", ran.r.windowOpen === "null" || String(ran.r.windowOpen).startsWith("blocked"), ran.r.windowOpen);
  result("srcdoc: inline <style> applies", ran.r.style === "rgb(1, 2, 3)", ran.r.style);
  result("srcdoc: script without nonce blocked", !by("no-nonce-ran"), by("no-nonce-ran") ? "ran" : "blocked");
  result("srcdoc: inline onclick blocked", !by("inline-handler-ran"), by("inline-handler-ran") ? "ran" : "blocked");
  result("srcdoc: module script with nonce runs", !!by("module-ran"), by("module-ran") ? "ran" : "did not run");
  result("srcdoc: fetch to network blocked", String(by("fetch")?.v).startsWith("blocked"), by("fetch")?.v ?? "no answer");
  result("srcdoc: WebSocket blocked", by("ws")?.v !== "created" || (by("violations")?.v ?? []).some((x) => x.startsWith("connect-src")), { ws: by("ws")?.v });
  result("srcdoc: remote image blocked", by("img")?.v === "error", by("img")?.v ?? "no answer");
  result("srcdoc: CSP violations reported inside the frame", true, by("violations")?.v ?? []);
  return true;
}

async function busyFrame() {
  const html = `<script nonce="${N}">parent.postMessage({kind:"start"},"*"); const t = Date.now(); while (Date.now() - t < 1500) {} parent.postMessage({kind:"end"},"*");</script>`;
  let done;
  const gap = await maxGap(async () => { done = frame(html, { wait: 2200 }); await sleep(10); }, 2000);
  const { msgs } = await done;
  result("srcdoc busy loop 1.5 s: longest stall of the reader page (ms)", gap < 500, { gap, sameProcessLikely: gap >= 1000, msgs: msgs.map((m) => m.kind) });
}

async function workers() {
  const code = `onmessage = (e) => { if (e.data === "loop") { for (;;) {} } postMessage({ sq: e.data * e.data }); };`;
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    const w = new Worker(url);
    const sq = await Promise.race([new Promise((r) => { w.onmessage = (e) => r(e.data.sq); w.onerror = (e) => r("error: " + e.message); w.postMessage(7); }), sleep(2000).then(() => "timeout")]);
    result("blob worker runs model code", sq === 49, sq);
    w.terminate();
  } catch (e) {
    result("blob worker runs model code", false, e.message);
  }
  try {
    const looping = new Worker(url);
    const gap = await maxGap(async () => { looping.postMessage("loop"); }, 800);
    looping.terminate();
    const after = await maxGap(async () => {}, 200);
    result("infinite loop in a worker: page stays responsive, terminate() stops it", gap < 300 && after < 200, { gapWhileLooping: gap, gapAfterTerminate: after });
  } catch (e) {
    result("infinite loop in a worker", false, e.message);
  }
  try {
    const direct = new Worker(P.worker, { type: "module" });
    const r = await Promise.race([new Promise((res) => { direct.onerror = (e) => res("error event: " + (e.message || "load failed")); direct.onmessage = () => res("message"); }), sleep(1500).then(() => "no error within 1.5 s")]);
    result("worker straight from the resource URI (expected to fail: other origin)", false, r);
    direct.terminate();
  } catch (e) {
    result("worker straight from the resource URI (expected to fail: other origin)", false, `${e.name}: ${e.message}`);
  }
}

async function pdf() {
  const t0 = performance.now();
  let pdfjs;
  try {
    pdfjs = await import(P.pdfjs);
  } catch (e) {
    result("pdf.js loads as a module", false, e.message);
    return;
  }
  result("pdf.js loads as a module", true, { version: pdfjs.version, ms: Math.round(performance.now() - t0) });
  try {
    const src = await (await fetch(P.worker)).text();
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(url, { type: "module" });
    result("pdf.js worker from blob (fetch resource → blob module worker)", true, { bytes: src.length });
  } catch (e) {
    result("pdf.js worker from blob", false, e.message);
    return;
  }
  const bytes = await new Promise((resolve) => {
    const on = (e) => { if (e.data && e.data.t === "pdf") { window.removeEventListener("message", on); resolve(e.data.bytes); } };
    window.addEventListener("message", on);
    vscode.postMessage({ t: "pdf?" });
  });
  result("PDF bytes arrive from the extension host", bytes instanceof Uint8Array, { type: Object.prototype.toString.call(bytes), length: bytes.length });
  try {
    const t1 = performance.now();
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    result("getDocument (isEvalSupported: false)", true, { pages: doc.numPages, ms: Math.round(performance.now() - t1) });
    const text = async (n) => (await (await doc.getPage(n)).getTextContent()).items.map((i) => ("str" in i ? i.str + (i.hasEOL ? "\n" : " ") : "")).join("");
    const t2 = performance.now();
    let all = "";
    for (let n = 1; n <= doc.numPages; n++) all += `\n[page ${n}]\n` + (await text(n));
    result("text of every page", all.length > 10_000, { chars: all.length, ms: Math.round(performance.now() - t2) });
    const stamp = all.match(/arXiv:\s?(\d{4}\.\d{4,5})(v\d+)?/);
    result("arXiv stamp found in the text (PDF → arXiv id)", !!stamp, stamp ? stamp[0] : "none");
    const at = all.search(/BAx|BA\s*x/);
    result("equation text as pdf.js gives it (Eq. 3 of LoRA)", at >= 0, at >= 0 ? all.slice(Math.max(0, at - 160), at + 60) : all.slice(0, 200));
    const eqPage = (all.slice(0, at).match(/\[page (\d+)\]/g) ?? []).pop()?.match(/\d+/)?.[0];
    const pageNo = Number(eqPage ?? 4);
    const t3 = performance.now();
    const page = await doc.getPage(pageNo);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    const png = canvas.toDataURL("image/png");
    result("render a page to PNG (for paper_page)", png.length > 10_000, { page: pageNo, width: canvas.width, height: canvas.height, pngKB: Math.round((png.length * 3) / 4 / 1024), ms: Math.round(performance.now() - t3) });
    vscode.postMessage({ t: "png", name: `lora-p${pageNo}.png`, data: png });
  } catch (e) {
    result("pdf.js on the LoRA PDF", false, `${e.name}: ${e.message}`);
  }
}

(async () => {
  result("probe page runs", true, { variant: P.variant, ua: navigator.userAgent });
  try { await sandboxChecks(); } catch (e) { result("sandbox checks crashed", false, e.message); }
  try { await busyFrame(); } catch (e) { result("busy frame crashed", false, e.message); }
  try { await workers(); } catch (e) { result("worker checks crashed", false, e.message); }
  try { await pdf(); } catch (e) { result("pdf checks crashed", false, e.message); }
  await sleep(300);
  vscode.postMessage({ t: "done" });
})();
