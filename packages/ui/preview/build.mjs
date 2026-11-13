// Builds the chat panel preview (see preview.tsx) into preview/dist.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
mkdirSync(out, { recursive: true });
copyFileSync(join(here, "../chat.css"), join(out, "chat.css"));
copyFileSync(join(here, "../../vscode/src/theme.css"), join(out, "theme.css"));
// VS Code's Dark Modern colors, as the webview would get them.
const vars = {
  "font-family": '"Segoe UI", sans-serif', "font-size": "13px", "editor-font-family": "Consolas, monospace",
  foreground: "#cccccc", descriptionForeground: "#9d9d9d", "sideBar-background": "#181818", "editor-background": "#1f1f1f",
  "input-background": "#313131", "input-border": "#3c3c3c", "widget-border": "#313131", "panel-border": "#2b2b2b",
  focusBorder: "#0078d4", "textLink-foreground": "#4daafc", "button-background": "#0078d4", "button-foreground": "#ffffff",
  "button-hoverBackground": "#026ec1", "button-secondaryBackground": "#313131", "button-secondaryForeground": "#cccccc",
  "button-secondaryHoverBackground": "#3c3c3c", "toolbar-hoverBackground": "#5a5d5e50", "editorWidget-background": "#202020",
  "chat-requestBackground": "#1f1f1f", "chat-requestBubbleBackground": "#2b3a4a", "testing-iconPassed": "#73c991",
  "editorWarning-foreground": "#cca700", errorForeground: "#f85149", "editor-selectionBackground": "#264f78",
  "diffEditor-insertedTextBackground": "#9ccc2c33", "diffEditor-removedTextBackground": "#ff000033",
};
const style = `:root{${Object.entries(vars).map(([k, v]) => `--vscode-${k}:${v}`).join(";")}} body{width:${process.env.WIDTH ?? 380}px;border-right:1px solid #333}`;
writeFileSync(join(out, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Chat preview</title>
<link rel="stylesheet" href="chat.css"><link rel="stylesheet" href="theme.css"><style>${style}</style></head>
<body class="vscode-dark"><div id="root"></div><script type="module" src="preview.js"></script></body></html>`);
await build({
  entryPoints: [join(here, "preview.tsx")], outfile: join(out, "preview.js"), bundle: true, format: "esm",
  jsx: "automatic", jsxImportSource: "preact", alias: { "@ainb/protocol": join(here, "../../protocol/src/index.ts") }, logLevel: "warning",
});
console.log(`open ${join(out, "index.html")}`);
