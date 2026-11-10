// A scripted ACP agent for tests. It connects to the MCP servers it is given,
// like a real agent, and follows a script embedded in the prompt:
//   SCRIPT: [{"tool":"list_cells","args":{}}, {"say":"hi"}, {"permission":"Run ls"}, {"sleep":200}]
// Every tool result is echoed back as a message chunk "RESULT <tool>: <text>".

import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sessions = new Map();
let model = "fast";

const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "fast", name: "Fast" },
      { value: "smart", name: "Smart" },
    ],
  },
];

async function connectMcp(servers) {
  const clients = [];
  for (const s of servers) {
    if (!("command" in s)) continue;
    const env = { ...process.env };
    for (const { name, value } of s.env ?? []) env[name] = value;
    const transport = new StdioClientTransport({ command: s.command, args: s.args, env });
    const client = new Client({ name: "fake-agent", version: "0.0.0" });
    await client.connect(transport);
    clients.push({ name: s.name, client });
  }
  return clients;
}

const app = agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: { mcpCapabilities: { http: false, sse: false } },
    authMethods: [],
  }))
  .onRequest("session/new", async ({ params }) => {
    const sessionId = `s${sessions.size + 1}`;
    sessions.set(sessionId, { mcp: await connectMcp(params.mcpServers), cancelled: false, turns: 0 });
    return { sessionId, configOptions: configOptions() };
  })
  .onRequest("session/set_config_option", ({ params }) => {
    model = String(params.value);
    return { configOptions: configOptions() };
  })
  .onNotification("session/cancel", ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (s) s.cancelled = true;
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const s = sessions.get(params.sessionId);
    s.cancelled = false;
    s.turns++;
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const say = (t) =>
      client.notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
      });
    if (text.includes("<agent-in-notebook>")) await say("[saw playbook]");
    if (text.includes("<earlier-conversation>")) await say("[saw recap]");
    const ctx = text.match(/<notebook-context>[\s\S]*?<\/notebook-context>/);
    if (ctx && text.includes("ECHO_CONTEXT")) await say(ctx[0]);
    if (text.split("\n").at(-1) === "CRASH") process.exit(3);
    const m = text.match(/SCRIPT: (\[.*\])/);
    const steps = m ? JSON.parse(m[1]) : [{ say: `echo: ${text.split("\n").at(-1)}` }];
    let n = 0;
    for (const step of steps) {
      if (s.cancelled) return { stopReason: "cancelled" };
      if (step.say) await say(step.say);
      if (step.sleep) {
        const end = Date.now() + step.sleep;
        while (Date.now() < end && !s.cancelled) await new Promise((r) => setTimeout(r, 20));
        if (s.cancelled) return { stopReason: "cancelled" };
      }
      if (step.permission) {
        const res = await client.request("session/request_permission", {
          sessionId: params.sessionId,
          toolCall: { toolCallId: `perm${++n}`, title: step.permission, kind: "execute", status: "pending", rawInput: { command: "ls" } },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        await say(`PERMISSION: ${res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"}`);
      }
      if (step.tool) {
        const id = `tc${++n}`;
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: id, title: `mcp__notebook__${step.tool}`, kind: "other", status: "in_progress", rawInput: step.args },
        });
        const mcp = s.mcp.find((c) => c.name === "notebook");
        const r = await mcp.client.callTool({ name: step.tool, arguments: step.args ?? {} }, undefined, { timeout: 600_000 });
        const out = r.content.map((c) => c.text).join("");
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: id, status: r.isError ? "failed" : "completed" },
        });
        await say(`RESULT ${step.tool}${r.isError ? " (error)" : ""}: ${out}\n`);
      }
    }
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
