// ER-0 (easy-read): runs inside a real VS Code as its "extension tests".
// Opens a webview with the CSP the reader tab would use and loads page.mjs,
// which tries what docs/easy-read.md § E.7.2 and E.10 depend on: sandboxed
// srcdoc frames for widgets, blob workers, pdf.js. Results go to
// AINB_PROBE_OUT (JSON), rendered pages next to it.

const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

exports.run = async function run() {
  const out = process.env.AINB_PROBE_OUT;
  const pdfPath = process.env.AINB_PROBE_PDF;
  const variant = process.env.AINB_PROBE_CSP || "reader";
  const here = __dirname;
  const pdfjs = path.resolve(here, "../../../../ui/node_modules/pdfjs-dist/build");
  const panel = vscode.window.createWebviewPanel("ainb.readerProbe", "Reader probe", vscode.ViewColumn.One, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(here), vscode.Uri.file(pdfjs)],
  });
  const w = panel.webview;
  const nonce = crypto.randomBytes(16).toString("base64");
  const uri = (p) => w.asWebviewUri(vscode.Uri.file(p)).toString();
  const src = w.cspSource;
  const csp = {
    // What the reader tab would declare (no frame-src: srcdoc frames are not fetched).
    reader: `default-src 'none'; img-src ${src} data: blob:; style-src ${src} 'unsafe-inline'; font-src ${src}; script-src 'nonce-${nonce}' ${src}; connect-src ${src}; worker-src blob:`,
    // The same, with frame-src, in case srcdoc frames turn out to need it.
    frames: `default-src 'none'; img-src ${src} data: blob:; style-src ${src} 'unsafe-inline'; font-src ${src}; script-src 'nonce-${nonce}' ${src}; connect-src ${src}; worker-src blob:; frame-src 'self' blob: data:`,
  }[variant];
  const config = { nonce, variant, pdfjs: uri(path.join(pdfjs, "pdf.min.mjs")), worker: uri(path.join(pdfjs, "pdf.worker.min.mjs")) };
  w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Reader probe</title></head>
<body><h3>ER-0 reader probe (${variant})</h3><div id="log" style="font:12px monospace"></div>
<script nonce="${nonce}">window.PROBE = ${JSON.stringify(config)};</script>
<script type="module" nonce="${nonce}" src="${uri(path.join(here, "page.mjs"))}"></script>
</body></html>`;

  await new Promise((resolve) => {
    const results = [];
    const started = Date.now();
    const finish = (why) => {
      clearTimeout(timer);
      fs.writeFileSync(out, JSON.stringify({ why, variant, vscode: vscode.version, electron: process.versions.electron, chrome: process.versions.chrome, ms: Date.now() - started, results }, null, 2));
      resolve();
    };
    const timer = setTimeout(() => finish("timeout"), 120_000);
    w.onDidReceiveMessage((m) => {
      if (m.t === "result") results.push({ name: m.name, ok: m.ok, detail: m.detail });
      else if (m.t === "pdf?") void w.postMessage({ t: "pdf", bytes: new Uint8Array(fs.readFileSync(pdfPath)) });
      else if (m.t === "png") fs.writeFileSync(path.join(path.dirname(out), `${variant}-${m.name}`), Buffer.from(String(m.data).split(",")[1], "base64"));
      else if (m.t === "done") finish("done");
    });
  });
  panel.dispose();
};
