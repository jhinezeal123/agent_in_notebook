import { context, build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

const common = {
  bundle: true,
  target: "chrome116",
  sourcemap: "linked",
  alias: { "@ainb/protocol": "../protocol/src/index.ts" },
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
};

const entries = [
  // The service worker and the side panel are ES modules; content scripts are classic scripts.
  { entryPoints: ["src/background/background.ts"], outfile: "dist/background.js", format: "esm" },
  { entryPoints: ["src/sidepanel/main.tsx"], outfile: "dist/sidepanel.js", format: "esm" },
  { entryPoints: ["src/content/content.ts"], outfile: "dist/content.js", format: "iife" },
  { entryPoints: ["src/page/main.ts"], outfile: "dist/page.js", format: "iife" },
];

if (watch) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
} else {
  await Promise.all(entries.map((e) => build({ ...common, ...e })));
}
