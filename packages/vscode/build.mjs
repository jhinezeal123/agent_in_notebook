import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

import { copyMathAssets } from "../ui/math-assets.mjs";
import { buildStudio } from "../studio/build.mjs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
copyFileSync("../ui/chat.css", "dist/chat.css");
copyFileSync("src/theme.css", "dist/theme.css");
copyFileSync("../ui/mentor.css", "dist/mentor.css");
copyMathAssets("dist");

const common = { bundle: true, logLevel: "info", alias: { "@ainb/protocol": "../protocol/src/index.ts" } };
await Promise.all([
  build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.cjs", platform: "node", target: "node22", external: ["vscode"] }),
  build({ ...common, entryPoints: ["src/webview.tsx"], outfile: "dist/webview.js", format: "esm", target: "chrome130", jsx: "automatic", jsxImportSource: "preact" }),
  // Mentor's home page (packages/ui/src/mentor).
  build({ ...common, entryPoints: ["src/mentor-view.tsx"], outfile: "dist/mentor.js", format: "esm", target: "chrome130", jsx: "automatic", jsxImportSource: "preact" }),
  // The research views, on OpenResearch's client code (see packages/studio).
  buildStudio("dist/studio.js", { optional: true }),
]);
