import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { PanelEvent, Prefs } from "../shared/panel-messages.js";

export interface PanelHost {
  readonly kind: "browser" | "vscode";
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  on(listener: (e: PanelEvent) => void): () => void;
  watchTab(listener: (id: number | null) => void): () => void;
  getPrefs(): Promise<Partial<Prefs> | undefined>;
  setPrefs(prefs: Prefs): Promise<void>;
  copy(text: string): Promise<void>;
  openLink(url: string): Promise<unknown>;
}

export const PanelHostContext = createContext<PanelHost | null>(null);

export function usePanelHost(): PanelHost {
  const host = useContext(PanelHostContext);
  if (!host) throw new Error("Panel host is missing.");
  return host;
}
