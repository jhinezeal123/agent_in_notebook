import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  // Separate chunks, so a command only loads the dependencies it uses (see cli.ts).
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // Runtime deps stay in node_modules (the agent adapters are resolved by path);
  // only the workspace protocol package is bundled in.
  packages: "external",
  alias: { "@ainb/protocol": "../protocol/src/index.ts" },
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});
