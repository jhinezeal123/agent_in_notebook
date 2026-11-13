// A notebook's stable identity, so a chat follows the notebook rather than the
// browser tab: reloading keeps it, opening another notebook in the tab does not.

import type { Platform } from "./notebook.js";

/**
 * Build the key from the tab's top-level URL (the notebook iframe on Kaggle
 * does not know which notebook it shows) and, for Jupyter, the document path.
 */
export function notebookKey(platform: Platform, tabUrl: string, docPath?: string): string {
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    return `${platform}:${tabUrl}${docPath ? `:${docPath}` : ""}`;
  }
  switch (platform) {
    case "colab": {
      // /drive/<id>, /github/<repo>/<path>, /notebooks/<file>; the legacy
      // /notebook#fileId=<id> form keeps the id in the hash.
      const fileId = new URLSearchParams(url.hash.slice(1)).get("fileId");
      return `colab:${url.pathname}${fileId ? `#${fileId}` : ""}`;
    }
    case "kaggle":
      // /code/<user>/<slug>/edit[/run/<n>] -> /code/<user>/<slug>
      return `kaggle:${url.pathname.replace(/\/edit(\/.*)?$/, "").replace(/\/$/, "")}`;
    case "jupyter":
      return `jupyter:${url.host}:${docPath ?? url.pathname}`;
  }
}
