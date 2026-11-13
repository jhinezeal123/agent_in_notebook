// The research views (VS Code webviews) are our own React screens on top of
// OpenResearch's own client logic: its API calls, live updates and data
// models are imported straight from an OpenResearch checkout at build time, so
// updating OpenResearch and rebuilding updates them here.
//
// The checkout: OPENRESEARCH_DIR, else ../openresearch_custom next to this
// repository. Its ui/ must have been installed (pnpm install) once.
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

export function openResearchDir() {
  const dir = resolve(process.env.OPENRESEARCH_DIR ?? join(here, "../../../openresearch_custom"));
  const ui = join(dir, "ui");
  if (!existsSync(join(ui, "src", "workspace.tsx"))) {
    throw new Error(`OpenResearch is not at ${dir}. Set OPENRESEARCH_DIR to an OpenResearch checkout.`);
  }
  if (!existsSync(join(ui, "node_modules", "react"))) {
    throw new Error(`Run "pnpm install" in ${ui} once, so its client code can be built here.`);
  }
  if (!existsSync(join(ui, "src", "paraglide", "messages.js"))) {
    throw new Error(`Run "pnpm exec paraglide-js compile --project ./project.inlang --outdir ./src/paraglide" in ${ui} once.`);
  }
  return dir;
}

function aliases(ui) {
  const mod = (name) => join(ui, "node_modules", name);
  return {
    "@orx": join(ui, "src"),
    "@ainb/protocol": join(here, "../protocol/src/index.ts"),
    react: mod("react"),
    "react-dom": mod("react-dom"),
    "@tanstack/react-query": mod("@tanstack/react-query"),
  };
}

/**
 * Build the screens into `outfile` (studio.css next to it). Without an
 * OpenResearch checkout, `optional` writes a stand-in that says so instead
 * of failing (the notebook chat builds and works without OpenResearch).
 */
export async function buildStudio(outfile, { optional = false } = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  // studio.css, then the compute screens' own rules (compute-*.css), as one file.
  const extra = readdirSync(here).filter((f) => /^compute-.*\.css$/.test(f)).sort();
  writeFileSync(join(dirname(outfile), "studio.css"), [readFileSync(join(here, "studio.css"), "utf8"), ...extra.map((f) => readFileSync(join(here, f), "utf8"))].join("\n"));
  let ui;
  try {
    ui = join(openResearchDir(), "ui");
  } catch (e) {
    if (!optional) throw e;
    console.warn(`Research views not built: ${e.message}`);
    const say = JSON.stringify(`The research views were not built: ${e.message}`);
    writeFileSync(outfile, `const el = document.getElementById("studio"); if (el) { el.className = "gate"; el.textContent = ${say}; }
`);
    return false;
  }
  await build({
    entryPoints: [join(here, "src/main.tsx")],
    outfile,
    bundle: true,
    format: "esm",
    target: "chrome130",
    jsx: "automatic",
    jsxImportSource: "react",
    alias: aliases(ui),
    nodePaths: [join(ui, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
    minify: true,
    legalComments: "none",
    logLevel: "info",
  });
  return true;
}

/** Type-check our screens against OpenResearch's code with its own compiler settings. */
function typecheck() {
  const ui = join(openResearchDir(), "ui");
  const rel = (p) => { const r = relative(here, p).replaceAll("\\", "/"); return r.startsWith(".") ? r : `./${r}`; };
  const config = {
    extends: rel(join(ui, "tsconfig.json")),
    compilerOptions: {

      paths: {
        "@orx/*": [`${rel(join(ui, "src"))}/*`],
        "@ainb/protocol": ["./../protocol/src/index.ts"],
        react: [rel(join(ui, "node_modules/@types/react"))],
        "react/*": [`${rel(join(ui, "node_modules/@types/react"))}/*`],
        "react-dom/*": [`${rel(join(ui, "node_modules/@types/react-dom"))}/*`],
        "@tanstack/react-query": [rel(join(ui, "node_modules/@tanstack/react-query"))],
        // OpenResearch's files outside ui/ (downstream/) find its packages here.
        "*": [`${rel(join(ui, "node_modules/@types"))}/*`, `${rel(join(ui, "node_modules"))}/*`],
      },
      types: [],
    },
    include: ["src", rel(join(ui, "src/vite-env.d.ts"))],
  };
  writeFileSync(join(here, "tsconfig.gen.json"), JSON.stringify(config, null, 2));
  const tsc = spawnSync(process.execPath, [join(here, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.gen.json"], { cwd: here, stdio: "inherit" });
  process.exitCode = tsc.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--typecheck")) typecheck();
  else await buildStudio(join(here, "dist/studio.js"));
}
