// Stands in for `orx up --headless --port 0`: announces its address on stderr
// the way orx does, answers /api/health, and streams one run change on
// /api/events. FAKE_ORX_FAIL=1 makes it exit at once, like a second orx.
// Also `orx discover <source> [flags] -- <query>` and `orx paper [--full] -- <id>`,
// answering from a tiny made-up library.
import { createServer } from "node:http";

const [command, ...rest] = process.argv.slice(2);
if (command === "discover") {
  const source = rest[0];
  const query = rest.at(-1);
  if (source === "pubmed") {
    console.error("Error: PubMed is turned off in OpenResearch settings. Turn it on there to search it.");
    process.exit(1);
  }
  const hits = query.includes("nothing")
    ? []
    : [
        { source: "alphaxiv", id: "2106.09685", title: "LoRA: Low-Rank Adaptation of Large Language Models", abstract: "We propose Low-Rank Adaptation.", publicationDate: "2021-06-17", votes: 120, snippets: [{ pageNumber: 4, snippet: "freeze the pretrained weights" }] },
        { source: "openalex", id: "W3000000001", title: "QLoRA", abstract: "Quantized LoRA.", publicationDate: "2023-05-23", citations: 900 },
      ];
  // What it was asked, so a test can see the flags reached orx.
  hits.forEach((h) => (h.abstract += ` [asked: ${rest.join(" ")}]`));
  console.log(JSON.stringify(hits, null, 2));
  process.exit(0);
}
if (command === "paper") {
  const id = rest.at(-1);
  if (id === "0000.00000") {
    console.error("Error: alphaXiv has no paper 0000.00000.");
    process.exit(1);
  }
  const body = rest.includes("--full") ? `FULL TEXT of ${id}. ${"word ".repeat(12_000)}THE END` : `# Report on ${id}\nLow-rank updates.`;
  console.log(`alphaXiv: https://www.alphaxiv.org/abs/${id}\n${body}`);
  process.exit(0);
}

if (command !== "up") {
  console.error(`unexpected arguments: ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}
if (process.env.FAKE_ORX_FAIL) {
  console.error("Error: Another OpenResearch dashboard is already using this database.");
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "9.9.9-fake", dashboardProtocol: 1, instanceId: "fake" }));
    return;
  }
  if (req.url === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": hello\n\n");
    const run = { id: "run_1", experimentId: "exp_1", projectId: "proj_1", status: "done", backend: "kaggle", startedAt: 1, endedAt: 2, exitCode: 0, command: "python train.py" };
    setTimeout(() => res.write(`event: experiment.updated\ndata: {"experiment":{}}\n\nevent: run.updated\ndata: ${JSON.stringify({ run })}\n\n`), 50);
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.error(`orx up: dashboard on http://127.0.0.1:${port}`);
});
