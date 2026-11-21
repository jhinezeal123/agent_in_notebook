// Stands in for an `orx up` that fails at startup (the database is held),
// counting every spawn in the file COUNTING_ORX_UP_LOG points at.
import { appendFileSync } from "node:fs";

appendFileSync(process.env.COUNTING_ORX_UP_LOG, `up ${process.argv.slice(2).join(" ")}\n`);
console.error("Error: Another OpenResearch dashboard is already using this database.");
process.exit(1);