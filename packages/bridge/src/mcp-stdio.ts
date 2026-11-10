// `ainb mcp`: the stdio MCP server an agent launches. It holds no state; every
// list and call is relayed to the bridge, which knows the chat by its token.
// Stdio is the one MCP transport every ACP agent must support.

import { request } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BRIDGE_VERSION } from "./config.js";

function post(path: string, body: unknown): Promise<any> {
  const base = process.env.AINB_URL;
  const token = process.env.AINB_CHAT_TOKEN;
  if (!base || !token) return Promise.reject(new Error("AINB_URL and AINB_CHAT_TOKEN must be set; this server is started by the bridge."));
  const url = new URL(path, base);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    // node:http instead of fetch: tool calls may wait on the user longer than fetch's header timeout.
    const req = request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: any;
          try {
            parsed = JSON.parse(text);
          } catch {
            return reject(new Error(`bridge answered ${res.statusCode}: ${text.slice(0, 200)}`));
          }
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(parsed?.error ?? `bridge answered ${res.statusCode}`));
          resolve(parsed);
        });
      },
    );
    req.on("error", (e) => reject(new Error(`The notebook bridge is not reachable (${e.message}).`)));
    req.end(data);
  });
}

export async function runMcpStdio(): Promise<void> {
  const server = new Server({ name: "notebook", version: BRIDGE_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await post("/mcp/list", {});
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await post("/mcp/call", { name: req.params.name, arguments: req.params.arguments ?? {} });
      return { content: [{ type: "text", text: String(result.text ?? "") }], isError: !!result.isError };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}
