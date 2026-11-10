import { fileURLToPath } from "node:url";
import { describeAgents } from "./agents/registry.js";
import { BRIDGE_VERSION, dataDir, loadConfig, resetToken } from "./config.js";
import { runMcpStdio } from "./mcp-stdio.js";
import { Bridge } from "./server.js";

const HELP = `agent-in-notebook bridge ${BRIDGE_VERSION}

Usage:
  ainb serve [--port N]   Run the bridge the browser extension connects to
  ainb token [--reset]    Print (or regenerate) the pairing token
  ainb agents             List the agents found on this machine
  ainb mcp                Notebook MCP server over stdio (started by agents)

Data directory: ${process.env.AINB_HOME ?? "~/.agent-in-notebook"}  (set AINB_HOME to change)
Custom ACP agents: add them to agents.json in the data directory.`;

async function main() {
  const [cmd = "serve", ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      const cfg = loadConfig();
      const portArg = rest.indexOf("--port");
      const port = portArg >= 0 ? Number(rest[portArg + 1]) : cfg.port;
      const self = fileURLToPath(import.meta.url);
      const bridge = new Bridge({ port, token: cfg.token, mcpCommand: { command: process.execPath, args: [self, "mcp"] } });
      try {
        await bridge.listen();
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use; is the bridge already running? Use --port to pick another.` : err.message);
        process.exit(1);
      }
      console.log(`agent-in-notebook bridge ${BRIDGE_VERSION} listening on 127.0.0.1:${bridge.port}`);
      console.log(`Pairing token: ${cfg.token}`);
      console.log(`Data: ${dataDir()}`);
      console.log("Agents:");
      for (const a of describeAgents()) console.log(`  ${a.available ? "✓" : "✗"} ${a.name.padEnd(12)} ${a.available ? "" : a.reason}`);
      const stop = async () => {
        await bridge.close();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "token": {
      const cfg = rest.includes("--reset") ? resetToken() : loadConfig();
      console.log(cfg.token);
      return;
    }
    case "agents":
      for (const a of describeAgents()) console.log(`${a.available ? "✓" : "✗"} ${a.id.padEnd(10)} ${a.name.padEnd(12)} ${a.available ? a.command : a.reason}`);
      return;
    case "mcp":
      await runMcpStdio();
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
