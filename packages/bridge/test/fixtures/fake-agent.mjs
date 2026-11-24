// A scripted ACP agent for tests. It connects to the MCP servers it is given,
// like a real agent, and follows a script embedded in the prompt:
//   SCRIPT: [{"tool":"Read","args":{"file_path":"test.ipynb"}}, {"say":"hi"}, {"permission":"Run ls"}, {"sleep":200}]
// A tool step can `capture` {name: regex} from its result; later args use it as {{name}}.
// Every tool result is echoed back as a message chunk "RESULT <tool>: <text>".

import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sessions = new Map();
let model = "fast";
let clientCapabilities = {};

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
  .onRequest("initialize", ({ params }) => {
    clientCapabilities = params.clientCapabilities ?? {};
    return {
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: false, sse: false }, promptCapabilities: { image: true } },
      authMethods: [],
    };
  })
  .onRequest("session/new", async ({ params }) => {
    const sessionId = `s${sessions.size + 1}`;
    sessions.set(sessionId, { mcp: await connectMcp(params.mcpServers), cancelled: false, turns: 0 });
    return { sessionId, configOptions: configOptions() };
  })
  .onRequest("session/set_config_option", async ({ params, client }) => {
    model = String(params.value);
    await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
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
    if (process.env.FAKE_AGENT_LOG) {
      const role = text.includes("<reader-checker>") ? "checker" : text.includes("<reader-author>") ? "author" : "other";
      appendFileSync(process.env.FAKE_AGENT_LOG, `${JSON.stringify({ tag: process.env.FAKE_AGENT_TAG ?? "fake", model, role })}\n`);
    }
    if (text.includes("<reader>\n")) s.reader = true;
    let said = false;
    const emitText = (t) =>
      client.notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
      });
    const say = (t) => {
      const framed = s.reader ? (said ? "" : "Hướng dẫn: ") + t.replace(/\n[\t ]*\n/g, "\n\nHướng dẫn: ") : t;
      said = true;
      return emitText(framed);
    };
    if (text.includes("<agent-in-notebook>")) await say("[saw playbook]");
    if (text.includes("<earlier-conversation>")) await say("[saw recap]");
    if (text.includes("<undo-note>")) await say("[saw undo note]");
    if (text.includes("<lit-review>\n")) await say(text.includes("They named no topic") ? "[saw lit-review, no topic]" : "[saw lit-review]");
    if (text.includes("<mentor>\n")) await say("[saw mentor playbook]");
    if (text.includes("<mentor-paper>\n")) await say("[saw paper playbook]");
    if (text.includes("<mentor-author>\n")) await say("[saw author playbook]");
    if (text.includes("<reader>\n")) await say("[saw reader playbook]");
    if (text.includes("<reader-author>\n")) await say("[saw reader-author playbook]");
    if (text.includes("<reader-checker>\n")) await say("[saw reader-checker playbook]");
    const grading = text.match(/<reader-grade write="[^"]+" kind="([^"]+)"/);
    if (grading) await say(`[saw reader-grade ${grading[1]}]`);
    if (text.includes("ECHO_PROMPT")) await say(`[prompt]${s.reader ? text.replaceAll("[[", "［［") : text}[/prompt]`);
    const selection = text.match(/<reader-selection kind="[^>]*>/);
    if (selection) await say(`[saw ${selection[0]}]`);
    if (text.includes("<hint-request level=")) await say(`[saw hint ${text.match(/<hint-request level="(\d)"/)?.[1]}${text.includes("Reference solution:") ? " with solution" : ""}]`);
    if (text.includes("<mentor-verdict>\n")) await say("[saw verdict]");
    if (text.includes("<code-review-request>\n")) await say(`[saw code review${text.includes("```python") ? " with reference" : ""}]`);
    const mentorState = text.match(/<mentor-state>[\s\S]*?<\/mentor-state>/);
    if (mentorState && text.includes("ECHO_MENTOR")) await say(mentorState[0]);
    if (text.includes("ECHO_MODEL")) await say(`[model ${model}]`);
    const ctx = text.match(/<notebook-context>[\s\S]*?<\/notebook-context>/);
    if (ctx && text.includes("ECHO_CONTEXT")) await say(ctx[0]);
    if (text.includes("ECHO_PROJECT")) {
      const blocks = text.match(/<project-(context|update|code)>[\s\S]*?<\/project-(context|update|code)>/g) ?? [];
      await say(blocks.length ? blocks.join("\n") : "[no project block]");
    }
    if (text.split("\n").at(-1) === "CRASH") process.exit(3);
    // A handoff recap may contain earlier scripts; only execute this turn's input.
    const m = text.split("\n").at(-1).match(/SCRIPT: (\[.*\])/);
    let steps = m ? JSON.parse(m[1]) : [{ say: `echo: ${text.split("\n").at(-1)}` }];
    // A paper's author: scripted per component in the file FAKE_AUTHOR names.
    const task = text.match(/<author-task (?:component="([^"]+)"|kind="given")/);
    // An exercise written again (the learner reported it) has a script of its own, `<slug>:rewrite`, when the file has one.
    if (task && process.env.FAKE_AUTHOR) {
      const scripts = JSON.parse(readFileSync(process.env.FAKE_AUTHOR, "utf8"));
      const again = /<author-task [^>]*kind="rewrite"/.test(text);
      steps = (again && scripts[`${task[1]}:rewrite`]) || scripts[task[1] ?? "given"] || [{ say: "no script" }];
    }
    // Easy-read's author and checker: scripted per task in the same file (reader:map, reader:checkpoint:<unit>, reader:fix:<unit>, reader:check).
    const readerTask = text.match(/<reader-task kind="(map|checkpoint|fix)"(?: unit="([^"]+)")?/);
    if ((readerTask || text.includes("<reader-check>")) && process.env.FAKE_AUTHOR) {
      const scripts = JSON.parse(readFileSync(process.env.FAKE_AUTHOR, "utf8"));
      const name = readerTask ? `reader:${readerTask[1]}${readerTask[2] ? `:${readerTask[2]}` : ""}` : "reader:check";
      steps = scripts[name] ?? [{ say: `no script for ${name}` }];
    }
    let n = 0;
    // What the learner said about the exercise, for a script to use as {{reported}}.
    const vars = { reported: text.match(/reported it as wrong:\n"""\n([\s\S]*?)\n"""/)?.[1] ?? "" };
    for (const step of steps) {
      if (s.cancelled) return { stopReason: "cancelled" };
      if (step.readerReply !== undefined) {
        await emitText("\n\n");
        for (const chunk of step.readerReply) await emitText(chunk);
      }
      if (step.say) await say(step.say);
      if (step.image) {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "image", ...step.image } },
        });
      }
      // Like Claude's adapter: report a compaction only to clients that support it.
      if (step.compact) {
        if (!clientCapabilities.session?.compaction) await say("[compaction not supported by client]");
        else {
          for (const status of ["in_progress", "completed"]) {
            await client.notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "compaction_update", compactionId: `k${s.turns}`, status } });
          }
        }
      }
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
          update: { sessionUpdate: "tool_call", toolCallId: id, title: `mcp__${step.server ?? "notebook"}__${step.tool}`, kind: "other", status: "in_progress", rawInput: step.args },
        });
        const mcp = s.mcp.find((c) => c.name === (step.server ?? "notebook"));
        const args = JSON.parse(JSON.stringify(step.args ?? {}).replace(/\{\{(\w+)\}\}/g, (_, k) => JSON.stringify(String(vars[k] ?? "")).slice(1, -1)));
        const r = await mcp.client.callTool({ name: step.tool, arguments: args }, undefined, { timeout: 600_000 });
        const out = r.content.filter((c) => c.type === "text").map((c) => c.text).join("");
        for (const [k, re] of Object.entries(step.capture ?? {})) vars[k] = out.match(new RegExp(re))?.[1];
        const images = r.content.filter((c) => c.type === "image");
        if (images.length) await say(`IMAGES ${images.length} ${images.map((i) => `${i.mimeType}:${i.data.length}`).join(",")}\n`);
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId: id, status: r.isError ? "failed" : "completed" },
        });
        // `quiet` calls say nothing, so several calls in a row sit next to each other like a real agent's.
        const diagnostic = s.reader ? out.replace(/\[\[(p\d+: "exact words")\]\]/g, "[$1]") : out;
        if (!step.quiet) await say(`RESULT ${step.tool}${r.isError ? " (error)" : ""}: ${diagnostic}\n`);
      }
    }
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
