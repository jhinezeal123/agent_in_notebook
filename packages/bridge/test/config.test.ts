// config.json and research.json: written atomically (no half file, no leftover
// temporary), and a broken file is kept aside as .bak instead of being lost.

import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_DEFAULT_PORT } from "@ainb/protocol";
import { loadConfig, loadResearchConfig, resetToken, saveResearchConfig } from "../src/config.js";

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.AINB_HOME;
  home = mkdtempSync(join(tmpdir(), "ainb-config-"));
  process.env.AINB_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.AINB_HOME;
  else process.env.AINB_HOME = savedHome;
  vi.restoreAllMocks();
});

const temporaries = () => readdirSync(home).filter((f) => f.endsWith(".tmp"));
const modeOf = (file: string) => statSync(join(home, file)).mode & 0o777;

describe("config.json", () => {
  it("is created atomically with a pairing token, and left alone when valid", () => {
    const first = loadConfig();
    expect(first.token.length).toBeGreaterThanOrEqual(16);
    expect(first.port).toBe(BRIDGE_DEFAULT_PORT);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual(first);
    expect(temporaries()).toEqual([]);
    if (process.platform !== "win32") expect(modeOf("config.json")).toBe(0o600);
    // A valid config is not rewritten (the token stays the pairing one).
    expect(loadConfig()).toEqual(first);
    expect(temporaries()).toEqual([]);
  });

  it("keeps a broken config.json as .bak and makes a valid new one", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(home, "config.json"), "{ broken");
    const cfg = loadConfig();
    expect(cfg.token.length).toBeGreaterThanOrEqual(16);
    expect(readFileSync(join(home, "config.json.bak"), "utf8")).toBe("{ broken");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual(cfg);
    expect(temporaries()).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toContain("config.json");
  });

  it("resetToken writes a new token atomically, keeping the port", () => {
    const first = loadConfig();
    const next = resetToken();
    expect(next.token).not.toBe(first.token);
    expect(next.token.length).toBeGreaterThanOrEqual(16);
    expect(next.port).toBe(first.port);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual(next);
    expect(temporaries()).toEqual([]);
    expect(existsSync(join(home, "config.json.bak"))).toBe(false);
    if (process.platform !== "win32") expect(modeOf("config.json")).toBe(0o600);
  });
});

describe("research.json", () => {
  it("round-trips through an atomic write and keeps unknown fields", () => {
    saveResearchConfig({ orxPath: "/opt/orx", env: { ORX_DATA_DIR: "/data" }, scratchProjectId: "proj_1" });
    expect(loadResearchConfig()).toEqual({ orxPath: "/opt/orx", env: { ORX_DATA_DIR: "/data" }, scratchProjectId: "proj_1" });
    expect(temporaries()).toEqual([]);
    writeFileSync(join(home, "research.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(home, "research.json"), "utf8")), futureField: "keep me" }));
    saveResearchConfig({ scratchProjectId: "proj_2" });
    const saved = JSON.parse(readFileSync(join(home, "research.json"), "utf8"));
    // Unknown fields are kept; the known ones come from what was saved.
    expect(saved).toEqual({ futureField: "keep me", scratchProjectId: "proj_2" });
    expect(temporaries()).toEqual([]);
  });

  it("keeps a broken research.json as .bak when loading, and answers {}", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(home, "research.json"), "{ broken");
    expect(loadResearchConfig()).toEqual({});
    expect(readFileSync(join(home, "research.json.bak"), "utf8")).toBe("{ broken");
    expect(existsSync(join(home, "research.json"))).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("keeps a broken research.json as .bak when saving over it", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(home, "research.json"), "{ broken");
    saveResearchConfig({ scratchProjectId: "proj_9" });
    expect(readFileSync(join(home, "research.json.bak"), "utf8")).toBe("{ broken");
    expect(loadResearchConfig()).toEqual({ scratchProjectId: "proj_9" });
    expect(temporaries()).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("does not invent a .bak when there is no file yet", () => {
    expect(loadResearchConfig()).toEqual({});
    saveResearchConfig({ scratchProjectId: "proj_1" });
    expect(existsSync(join(home, "research.json.bak"))).toBe(false);
    expect(loadResearchConfig()).toEqual({ scratchProjectId: "proj_1" });
  });
});