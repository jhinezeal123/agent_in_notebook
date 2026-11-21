// Stands in for `orx paper [--full] -- <id>`, counting every run in the file
// COUNTING_ORX_LOG points at, so a test can see which reads ran the CLI.
// Prints a text long enough to page, and refuses one id like alphaXiv would.
import { appendFileSync } from "node:fs";

const [command, ...rest] = process.argv.slice(2);
if (command !== "paper") {
  console.error(`unexpected arguments: ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
appendFileSync(process.env.COUNTING_ORX_LOG, `${process.argv.slice(2).join(" ")}\n`);
const id = rest.at(-1);
if (id === "fail.0001") {
  console.error("Error: alphaXiv has no paper fail.0001.");
  process.exit(1);
}
const body = rest.includes("--full") ? `COUNTED FULL TEXT of ${id}. ${"word ".repeat(12_000)}THE END` : `# Counted report on ${id}\nA short abstract.`;
console.log(body);
process.exit(0);