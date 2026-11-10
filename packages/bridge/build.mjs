import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
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
