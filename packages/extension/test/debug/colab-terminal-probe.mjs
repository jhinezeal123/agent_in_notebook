// Looks through the scripts Colab's page loads for how its terminal reaches
// the runtime (no sign-in needed to load the page).
//   node test/debug/colab-terminal-probe.mjs [regex]
import { chromium } from "playwright";

const pattern = new RegExp(process.argv[2] ?? "colab/tty|/terminals/|api/terminals|terminals/websocket|TerminalConnection|\\btty\\b", "g");
const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true });
const scripts = new Map();
try {
  const nb = await ctx.newPage();
  nb.on("response", async (res) => {
    const type = res.request().resourceType();
    if (type !== "script") return;
    try {
      scripts.set(res.url(), await res.text());
    } catch {
      // gone
    }
  });
  await nb.goto("https://colab.research.google.com/github/googlecolab/colabtools/blob/main/notebooks/colab-github-demo.ipynb", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await nb.waitForFunction(() => window.colab?.global?.notebook?.cells?.length > 0, null, { timeout: 120_000 });
  await nb.waitForTimeout(5000);
  for (const [url, text] of scripts) {
    const hits = new Map();
    for (const m of text.matchAll(pattern)) {
      const at = m.index ?? 0;
      const snippet = text.slice(Math.max(0, at - 160), at + 200).replace(/\s+/g, " ");
      if (hits.size < 12) hits.set(snippet, true);
    }
    if (!hits.size) continue;
    console.log(`==== ${url.slice(0, 120)} (${text.length} chars)`);
    for (const s of hits.keys()) console.log(`  … ${s} …\n`);
  }
} finally {
  await ctx.close();
}
