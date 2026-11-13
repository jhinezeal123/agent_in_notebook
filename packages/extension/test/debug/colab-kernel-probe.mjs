// Prints the source of Colab's kernel methods used to run code without a cell
// (no sign-in needed to load the page).
//   node test/debug/colab-kernel-probe.mjs [method ...]
import { chromium } from "playwright";

const names = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true });
try {
  const nb = await ctx.newPage();
  await nb.goto("https://colab.research.google.com/github/googlecolab/colabtools/blob/main/notebooks/colab-github-demo.ipynb", { waitUntil: "domcontentloaded", timeout: 120_000 });
  await nb.waitForFunction(() => window.colab?.global?.notebook?.cells?.length > 0, null, { timeout: 120_000 });
  const out = await nb.evaluate((names) => {
    const nb = window.colab.global.notebook;
    const k = nb.getKernel?.() ?? nb.kernel;
    const res = {};
    for (const n of names) {
      const [obj, m] = n.startsWith("nb.") ? [nb, n.slice(3)] : [k, n];
      res[n] = String(obj[m]).slice(0, 3000);
    }
    return res;
  }, names);
  for (const [n, s] of Object.entries(out)) console.log(`==== ${n}\n${s}\n`);
} finally {
  await ctx.close();
}
