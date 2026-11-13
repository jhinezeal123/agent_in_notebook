import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFileLink, externalChatUrl } from "../src/shared/chat-links.js";
import { splitMarkdownBlocks } from "../src/sidepanel/markdown.js";

describe("chat links", () => {
  it("recognizes file destinations and keeps one-based positions", () => {
    expect(chatFileLink("src/main.py:12:3")).toEqual({ path: "src/main.py", line: 12, column: 3 });
    expect(chatFileLink("file:///C:/my%20project/model.py#L20")).toMatchObject({ path: "C:/my project/model.py", line: 20 });
    expect(chatFileLink("file://other-machine/shared/notebook.ipynb")).toBeUndefined();
    expect(chatFileLink("https://example.org/src/main.py:12")).toBeUndefined();
  });

  it("only opens supported absolute external URLs", () => {
    expect(externalChatUrl("https://example.org/path")).toBe("https://example.org/path");
    expect(externalChatUrl("mailto:hi@example.org")).toBe("mailto:hi@example.org");
    for (const target of ["javascript:alert(1)", "command:workbench.action.closeWindow", "//example.org", "file:///tmp/file.txt"]) {
      expect(externalChatUrl(target)).toBeUndefined();
      if (!target.startsWith("file:")) expect(chatFileLink(target)).toBeUndefined();
    }
  });
});

it("keeps display math with blank lines together while streaming", () => {
  for (const math of ["$$\na\n\n+b\n$$", "\\[\na\n\n+b\n\\]", "$$\n\\begin{aligned}\n\na &= b"]) {
    const message = `Before.\n\n${math}`;
    expect(splitMarkdownBlocks(message)).toEqual([message]);
  }
});

declare global {
  interface Window { renderChatMarkdown: (source: string, localLinks?: boolean) => string }
}

// Install the browser with `pnpm --filter @ainb/extension exec playwright install chromium --only-shell`.
describe.skipIf(!process.env.E2E_MARKDOWN)("chat renderer in Chromium", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    const { outputFiles } = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: 'import { renderMarkdown } from "./src/sidepanel/markdown.ts"; window.renderChatMarkdown = renderMarkdown;',
      },
      bundle: true,
      write: false,
    });
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    page = await browser.newPage();
    await page.addScriptTag({ content: outputFiles[0]!.text });
  });
  afterAll(async () => { await browser?.close(); });

  const render = (source: string, localLinks = false) => page.evaluate(({ source, localLinks }) => {
    document.body.innerHTML = window.renderChatMarkdown(source, localLinks);
  }, { source, localLinks });

  it("renders all four delimiters, leaves code and prices intact, and falls back on malformed TeX", async () => {
    await render([
      String.raw`Inline $x^2$ and \(\alpha + 1\).`, "",
      "$$", String.raw`\begin{aligned}x &= 1 \\ y &= 2\end{aligned}`, "$$", "",
      String.raw`\[\frac{1}{2}\]`, "",
      "`$literal$`", "", "```python", 'price = "$10"', "```", "", "    $indented$", "",
      String.raw`It costs $5 and $10. Literal \$x\$. Incomplete $z. Invalid $\madeUpCommand{x}$.`,
    ].join("\n"));
    expect(await page.locator(".katex").count()).toBe(4);
    expect(await page.locator(".katex-display").count()).toBe(2);
    expect(await page.locator("math").count()).toBe(4);
    expect(await page.locator("code").allTextContents()).toEqual(["$literal$", 'price = "$10"', "$indented$"]);
    expect(await page.locator(".math-fallback").allTextContents()).toEqual([String.raw`$\madeUpCommand{x}$`]);
    expect(await page.locator("body").innerText()).toContain("It costs $5 and $10. Literal $x$. Incomplete $z.");
  });

  it("renders fenced math and preserves literal math in fenced LaTeX code", async () => {
    await render("```math\n\\sum_{i=1}^n i\n```\n\n```latex\n$x^2$\n```");
    expect(await page.locator(".katex-display").count()).toBe(1);
    expect(await page.locator("code").allTextContents()).toEqual(["$x^2$"]);
  });

  it("preserves image alt text and resolves only supported image sources", async () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
    const source = [
      "![Remote chart](https://example.org/chart.png)", `![Embedded chart](${png})`,
      "![Workspace chart][chart]", "![Blocked chart](data:image/svg+xml;base64,AAAA)",
      '<img alt="Raw chart" src="https://example.org/alt.png" srcset="https://example.org/other.png" onerror="bad()">',
      "", "[chart]: ./plots/loss.png",
    ].join("\n\n");
    await render(source, true);
    const remote = page.locator('img[alt="Remote chart"]');
    expect(await remote.getAttribute("src")).toBe("https://example.org/chart.png");
    expect(await remote.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(await page.locator('img[alt="Embedded chart"]').getAttribute("src")).toBe(png);
    expect(await page.locator('img[alt="Workspace chart"]').getAttribute("data-local-image")).toBe("./plots/loss.png");
    expect(await page.locator('.image-unavailable img[alt="Blocked chart"]').getAttribute("src")).toBeNull();
    expect(await page.locator('img[alt="Raw chart"]').getAttribute("srcset")).toBeNull();
    expect(await page.locator('img[alt="Raw chart"]').getAttribute("onerror")).toBeNull();
    await render(source);
    expect(await page.locator('.image-unavailable img[alt="Workspace chart"]').count()).toBe(1);
  });

  it("renders GFM and filters unsafe destinations and styles", async () => {
    const text = [
      "## Table", "", "| Key | Value |", "| --- | --- |", "| $x$ | **2** |", "", "- [x] Done", "",
      "[Guide](https://example.org/docs) and https://example.org/plain.", "",
      "[reference][src] [windows](file:///C:/test.py#L3) [blocked](command:workbench.action.closeWindow)", "",
      "[src]: ./src/main.py:12:3", "", '<span style="position: fixed" onclick="bad()">HTML</span>', "",
      String.raw`$\href{https://example.org/tex}{x}$`,
    ].join("\n");
    await render(text, true);
    expect(await page.locator(".md-table td .katex").count()).toBe(1);
    expect(await page.getByRole("checkbox").isChecked()).toBe(true);
    expect(await page.getByRole("link", { name: "Guide" }).getAttribute("href")).toBe("https://example.org/docs");
    expect(await page.getByRole("link", { name: "https://example.org/plain" }).getAttribute("href")).toBe("https://example.org/plain");
    expect(await page.getByRole("link", { name: "reference" }).getAttribute("data-file-link")).toBe("./src/main.py:12:3");
    expect(await page.getByRole("link", { name: "windows" }).getAttribute("data-file-link")).toBe("file:///C:/test.py#L3");
    expect(await page.getByRole("link", { name: "blocked" }).count()).toBe(0);
    expect(await page.getByText("HTML", { exact: true }).getAttribute("style")).toBeNull();
    expect(await page.getByText("HTML", { exact: true }).getAttribute("onclick")).toBeNull();
    expect(await page.locator('a[href="https://example.org/tex"]').count()).toBe(0);
    await render(text);
    expect(await page.getByRole("link", { name: "reference" }).count()).toBe(0);
  });
});
