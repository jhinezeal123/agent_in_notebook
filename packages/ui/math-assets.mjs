import { copyFileSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function copyMathAssets(outputDirectory) {
  const dist = new URL(".", import.meta.resolve("katex"));
  copyFileSync(new URL("katex.min.css", dist), join(outputDirectory, "katex.min.css"));
  copyFileSync(new URL("../LICENSE", dist), join(outputDirectory, "KaTeX-LICENSE.txt"));
  cpSync(fileURLToPath(new URL("fonts/", dist)), join(outputDirectory, "fonts"), { recursive: true });
}
