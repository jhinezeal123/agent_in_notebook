import { describe, expect, it } from "vitest";
import { kernelHint, loginHintFrom } from "../src/chat-hints.js";

describe("kernelHint", () => {
  it("tells each platform what to do when its kernel is not connected", () => {
    expect(kernelHint("colab", "disconnected")).toBe("Runtime not connected — open the Colab tab and press Connect.");
    expect(kernelHint("colab", "unknown")).toBe("Runtime not connected — open the Colab tab and press Connect.");
    expect(kernelHint("kaggle", "disconnected")).toBe("Kernel not connected — check the notebook's tab.");
    expect(kernelHint("jupyter", "unknown")).toBe("Kernel not connected — check the notebook's tab.");
    expect(kernelHint("vscode", "disconnected")).toBe("No kernel — select one with the Jupyter extension.");
  });

  it("says nothing while the kernel is idle or busy", () => {
    for (const platform of ["colab", "kaggle", "jupyter", "vscode"] as const) {
      expect(kernelHint(platform, "idle")).toBeNull();
      expect(kernelHint(platform, "busy")).toBeNull();
    }
  });
});

describe("loginHintFrom", () => {
  it("is null without an error or without sign-in advice in it", () => {
    expect(loginHintFrom(null)).toBeNull();
    expect(loginHintFrom(undefined)).toBeNull();
    expect(loginHintFrom("")).toBeNull();
    expect(loginHintFrom("Codex exited (code 1). Send a message to restart it.")).toBeNull();
  });

  it("finds the login hint the bridge appends as the error's last line", () => {
    const error = "Authentication failed: token expired.\nSign in by running `codex login` in a terminal, or set OPENAI_API_KEY.";
    expect(loginHintFrom(error)).toBe("Sign in by running `codex login` in a terminal, or set OPENAI_API_KEY.");
  });

  it("prefers the last line that reads like sign-in advice", () => {
    const error = "auth error\nsome stderr\nConfigure a provider by running `opencode auth login` in a terminal.";
    expect(loginHintFrom(error)).toBe("Configure a provider by running `opencode auth login` in a terminal.");
  });

  it("recognizes API-key hints and trims the line", () => {
    expect(loginHintFrom("  Set GEMINI_API_KEY, or use a paid Gemini Code Assist account.  ")).toBe("Set GEMINI_API_KEY, or use a paid Gemini Code Assist account.");
  });
});