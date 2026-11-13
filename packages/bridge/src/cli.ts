import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { BRIDGE_VERSION, dataDir, loadConfig, resetToken, STOPPED_MARK } from "./config.js";

// Commands load what they need when they run: the browser waits on `native-host`
// and every agent session starts `mcp`, and the server's dependencies take seconds to load.
const server = () => import("./server.js");
const agents = () => import("./agents/registry.js");
const native = () => import("./native-host.js");

const HELP = `agent-in-notebook bridge ${BRIDGE_VERSION}

Usage:
  ainb install [--extension-id ID]   Let the browser extension start and pair with the bridge by itself
  ainb uninstall                     Undo "install"
  ainb serve [--port N] [--log F]    Run the bridge in this console (or logging to file F)
  ainb status                        Is the bridge running?
  ainb stop                          Stop a running bridge (also one the extension started)
  ainb token [--reset]               Print (or regenerate) the pairing token
  ainb agents                        List the agents found on this machine
  ainb mcp                           Notebook MCP server over stdio (started by agents)
  ainb native-host                   Native messaging host (started by the browser)

Data directory: ${process.env.AINB_HOME ?? "~/.agent-in-notebook"}  (set AINB_HOME to change)
Custom ACP agents: add them to agents.json in the data directory.`;

const self = fileURLToPath(import.meta.url);

/** Values of a repeatable flag: --name a --name b, or --name=a. */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === name && args[i + 1]) out.push(args[i + 1]!);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out;
}

async function running(port: number): Promise<{ version: string; extension: boolean } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { ok?: boolean; version: string; extension: boolean };
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

async function main() {
  const [cmd = "serve", ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      // Started in the background (by the native host): no console, so write to a file.
      const logFile = flagValues(rest, "--log")[0];
      if (logFile) {
        const write = (...args: unknown[]) => appendFileSync(logFile, format(...args) + "\n");
        console.log = console.info = console.warn = console.error = write;
        const exit = process.exit.bind(process);
        process.exit = ((code?: number) => {
          if (code) write(STOPPED_MARK);
          return exit(code);
        }) as typeof process.exit;
        process.on("uncaughtException", (e) => {
          write(e);
          process.exit(1);
        });
      }
      const cfg = loadConfig();
      const portArg = rest.indexOf("--port");
      const port = portArg >= 0 ? Number(rest[portArg + 1]) : cfg.port;
      const stop = async () => {
        await bridge.close();
        process.exit(0);
      };
      const [{ Bridge }, { describeAgents }] = await Promise.all([server(), agents()]);
      const bridge = new Bridge({ port, token: cfg.token, mcpCommand: { command: process.execPath, args: [self, "mcp"] }, onShutdown: () => void stop() });
      try {
        await bridge.listen();
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        console.error(err.code === "EADDRINUSE" ? `Port ${port} is in use; is the bridge already running? Stop it with "ainb stop", or use --port to pick another.` : err.message);
        process.exit(1);
      }
      console.log(`agent-in-notebook bridge ${BRIDGE_VERSION} listening on 127.0.0.1:${bridge.port}`);
      console.log(`Pairing token: ${cfg.token}`);
      console.log(`Data: ${dataDir()}`);
      console.log("Agents:");
      for (const a of describeAgents()) console.log(`  ${a.available ? "✓" : "✗"} ${a.name.padEnd(12)} ${a.available ? "" : a.reason}`);
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "install": {
      const r = (await native()).installNativeHost(self, flagValues(rest, "--extension-id"));
      console.log(`Registered for ${r.browsers.join(", ")} (${r.manifest}).`);
      console.log(`Allowed extension IDs: ${r.extensionIds.join(", ")}`);
      console.log("Open the extension's side panel: it starts the bridge and pairs by itself.");
      console.log(`Moved this folder or changed Node? Run "ainb install" again.`);
      return;
    }
    case "uninstall": {
      const removed = (await native()).uninstallNativeHost();
      console.log(removed.length ? `Unregistered from ${removed.join(", ")}.` : "Nothing was registered.");
      return;
    }
    case "status": {
      const cfg = loadConfig();
      const r = await running(cfg.port);
      console.log(r ? `Running on 127.0.0.1:${cfg.port} (version ${r.version}), extension ${r.extension ? "connected" : "not connected"}.` : `Not running on port ${cfg.port}.`);
      process.exit(r ? 0 : 1);
    }
    case "stop": {
      const cfg = loadConfig();
      if (!(await running(cfg.port))) {
        console.log(`Not running on port ${cfg.port}.`);
        return;
      }
      const res = await fetch(`http://127.0.0.1:${cfg.port}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}` } }).catch(() => null);
      if (!res?.ok) {
        console.error("The bridge refused to stop (its token differs from config.json; was it started with another AINB_HOME?).");
        process.exit(1);
      }
      for (let i = 0; i < 40 && (await running(cfg.port)); i++) await new Promise((r) => setTimeout(r, 250));
      console.log("Stopped.");
      return;
    }
    case "token": {
      const cfg = rest.includes("--reset") ? resetToken() : loadConfig();
      console.log(cfg.token);
      return;
    }
    case "agents":
      for (const a of (await agents()).describeAgents()) console.log(`${a.available ? "✓" : "✗"} ${a.id.padEnd(10)} ${a.name.padEnd(12)} ${a.available ? a.command : a.reason}`);
      return;
    case "mcp":
      await (await import("./mcp-stdio.js")).runMcpStdio();
      return;
    case "native-host":
      await (await native()).runNativeHost(self);
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
