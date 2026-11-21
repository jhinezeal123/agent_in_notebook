// Small explanations the chat shows when something is not ready: what to do
// about a kernel that is not connected, and the sign-in line an agent error
// may carry. Pure, so they can be tested without a host.

import type { KernelState, Platform } from "@ainb/protocol";

/** What to do about a kernel that is not connected, in the notebook's own terms. */
export function kernelHint(platform: Platform, kernel: KernelState): string | null {
  if (kernel !== "disconnected" && kernel !== "unknown") return null;
  switch (platform) {
    case "colab": return "Runtime not connected — open the Colab tab and press Connect.";
    case "kaggle":
    case "jupyter": return "Kernel not connected — check the notebook's tab.";
    case "vscode": return "No kernel — select one with the Jupyter extension.";
  }
}

const AUTH_LINE = /sign in|sign-in|log ?in|api[_ ]?key|\bauth\b|authentication/i;

/**
 * The sign-in instruction an agent error carries, if any: the bridge appends
 * its login hint as the error's last line, so the last line that reads like
 * sign-in advice is the one to show.
 */
export function loginHintFrom(error: string | null | undefined): string | null {
  if (!error) return null;
  const lines = error.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line && AUTH_LINE.test(line)) return line;
  }
  return null;
}