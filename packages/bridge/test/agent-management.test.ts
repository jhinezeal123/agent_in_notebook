import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLaunchCommand } from "@ainb/protocol";
import { loadCustomAgents, removeCustomAgent } from "../src/config.js";
import { saveAgent, testAgent } from "../src/agents/manage.js";
import { describeAgents } from "../src/agents/registry.js";

const previousHome = process.env.AINB_HOME;
let home: string;
const command = formatLaunchCommand(process.execPath, [resolve(__dirname, "fixtures/fake-agent.mjs")]);

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ainb-agent-test-")); process.env.AINB_HOME = home; });
afterEach(() => { if (previousHome === undefined) delete process.env.AINB_HOME; else process.env.AINB_HOME = previousHome; });

describe("saved ACP launch commands", () => {
  it("adds and removes an agent with only a command", () => {
    const saved = saveAgent({ launchCommand: command });
    expect(saved).toMatchObject({ available: true, builtin: false, launchCommand: command });
    expect(describeAgents().some((a) => a.id === saved.id)).toBe(true);
    expect(removeCustomAgent(saved.id)).toBe(true);
    expect(describeAgents().some((a) => a.id === saved.id)).toBe(false);
  });

  it("keeps legacy array entries, env and unknown fields when editing", () => {
    writeFileSync(join(home, "agents.json"), JSON.stringify([{ id: "legacy", name: "Legacy", command: process.execPath, env: { AGENT_SETTING: "preserved" }, toolWaitSeconds: 42, future: true }]));
    saveAgent({ id: "legacy", name: "Renamed", launchCommand: command });
    expect(JSON.parse(readFileSync(join(home, "agents.json"), "utf8"))[0]).toMatchObject({ id: "legacy", name: "Renamed", env: { AGENT_SETTING: "preserved" }, toolWaitSeconds: 42, future: true });
  });

  it("preserves the object document format and unrelated agents", () => {
    writeFileSync(join(home, "agents.json"), JSON.stringify({ schemaVersion: 2, agents: [{ id: "other", name: "Other", command: process.execPath }] }));
    const saved = saveAgent({ name: "New", launchCommand: command });
    removeCustomAgent(saved.id);
    expect(JSON.parse(readFileSync(join(home, "agents.json"), "utf8"))).toEqual({ schemaVersion: 2, agents: [{ id: "other", name: "Other", command: process.execPath }] });
  });

  it("does not overwrite a corrupt catalog", () => {
    writeFileSync(join(home, "agents.json"), "{ broken");
    expect(() => saveAgent({ launchCommand: command })).toThrow();
    expect(readFileSync(join(home, "agents.json"), "utf8")).toBe("{ broken");
  });

  it("reports a missing executable and never saves it", () => {
    expect(() => saveAgent({ launchCommand: "ainb-nonexistent-agent-12345 acp" })).toThrow(/not found/);
    expect(loadCustomAgents()).toEqual([]);
    expect(() => saveAgent({ id: "claude", launchCommand: command })).toThrow(/no longer exists/);
  });

  it("tests ACP startup and reads models without sending a prompt", async () => {
    const result = await testAgent(command);
    expect(result.options).toContainEqual(expect.objectContaining({ category: "model", choices: expect.arrayContaining([expect.objectContaining({ value: "smart" })]) }));
    expect(loadCustomAgents()).toEqual([]);
  });
});
