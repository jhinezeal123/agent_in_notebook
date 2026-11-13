// Stands in for `orx up --headless --port 0`: announces its address on stderr
// the way orx does, answers /api/health, and streams one run change on
// /api/events. FAKE_ORX_FAIL=1 makes it exit at once, like a second orx.
import { createServer } from "node:http";

if (process.argv[2] !== "up") {
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
