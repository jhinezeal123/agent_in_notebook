import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

import { copyMathAssets } from "../extension/math-assets.mjs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
copyFileSync("../extension/static/sidepanel.css", "dist/sidepanel.css");
copyFileSync("src/theme.css", "dist/theme.css");
copyMathAssets("dist");

const common = { bundle: true, logLevel: "info", alias: { "@ainb/protocol": "../protocol/src/index.ts" } };
await Promise.all([
  build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", platform: "node", target: "node22", external: ["vscode"] }),
  build({ ...common, entryPoints: ["src/webview.tsx"], outfile: "dist/webview.js", format: "esm", target: "chrome130", jsx: "automatic", jsxImportSource: "preact" }),
]);
