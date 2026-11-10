import { describe, expect, it } from "vitest";
import { formatLaunchCommand, parseLaunchCommand } from "../src/launch.js";

describe("ACP launch commands", () => {
  it("splits an executable and arguments", () => {
    expect(parseLaunchCommand(" dsh --profile acp ")).toEqual({ command: "dsh", args: ["--profile", "acp"] });
    expect(parseLaunchCommand("claude-fp-acp")).toEqual({ command: "claude-fp-acp", args: [] });
  });

  it("preserves Windows paths, spaces and empty arguments", () => {
    expect(parseLaunchCommand('"C:\\Program Files\\Agent\\agent.cmd" --config "C:\\Users\\Me\\config.json" ""')).toEqual({
      command: "C:\\Program Files\\Agent\\agent.cmd", args: ["--config", "C:\\Users\\Me\\config.json", ""],
    });
  });

  it("round trips quoted values without evaluating them", () => {
    const args = ["two words", "O'Reilly", 'a "quote"', "$HOME; & whoami", "", "C:\\a b\\config"];
    expect(parseLaunchCommand(formatLaunchCommand("C:\\Program Files\\agent.exe", args))).toEqual({ command: "C:\\Program Files\\agent.exe", args });
  });

  it.each(["", "''", "dsh | other", "dsh && other", "dsh > file", "TOKEN=x dsh", "dsh `exec`", "dsh $TOKEN", "dsh 'unterminated", "dsh\nother", "dsh\0"])("rejects invalid command %j", (command) => {
    expect(() => parseLaunchCommand(command)).toThrow();
  });
});
