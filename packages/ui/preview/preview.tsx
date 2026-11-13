// A look at the chat panel without VS Code or a bridge: the real chat UI with
// made-up notebook and chat data, in VS Code's dark theme colors.
// Build: node packages/ui/preview/build.mjs, then open packages/ui/preview/dist/index.html.
import { render } from "preact";
import type { ChatSnapshot, NotebookInfo } from "@ainb/protocol";
import { App } from "../src/app.js";
import { PanelHostContext, type PanelHost } from "../src/host.js";
import type { BridgeState, PanelEvent, Prefs } from "../src/panel-messages.js";

const empty = new URLSearchParams(location.search).has("empty");
const notebook: NotebookInfo = {
  platform: "colab", title: "train_resnet.ipynb", url: "https://colab.research.google.com/drive/x", cellCount: 12,
  activeCellId: "c7f3a91b20", selectedCellIds: [], kernel: "idle", language: "python", key: "colab:x",
};
const now = Date.now();
const chat: ChatSnapshot = {
  chatId: "chat1", tabId: -7, agentId: "claude", agentName: "Claude Code", notebookKey: "colab:x", status: "running",
  settings: { scope: "write", review: true, targetCellIds: [], notebookOnly: true }, notebook,
  usage: { used: 53_000, size: 200_000 },
  options: [
    { id: "model", name: "Model", category: "model", kind: "select", value: "sonnet", choices: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }] },
    { id: "effort", name: "Effort", category: "thought_level", kind: "select", value: "high", choices: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  ],
  messages: empty ? [] : [
    { id: "m1", role: "user", createdAt: now - 60_000, parts: [{ type: "text", text: "Why does the loss stop going down after epoch 3? Fix it." }] },
    {
      id: "m2", role: "agent", createdAt: now - 50_000, changes: { count: 1 },
      parts: [
        { type: "thought", text: "The learning rate schedule looks wrong; let me read the training cell." },
        { type: "tool", toolCallId: "t1", title: "Read train_resnet.ipynb", status: "completed", notebook: true, detail: "12 cells" },
        { type: "tool", toolCallId: "t2", title: "Grep \"lr\" in train_resnet.ipynb", status: "completed", notebook: true },
        { type: "tool", toolCallId: "t3", title: "Bash: nvidia-smi", status: "completed", detail: "Tesla T4, 15 GB" },
        { type: "text", text: "The scheduler divides the learning rate by **10 every epoch**, so after epoch 3 it is `1e-5` and training stalls.\n\nI changed it to a cosine schedule:\n\n```python\nscheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)\n```" },
        { type: "review", status: "pending", review: { reviewId: "r1", cellId: "c7f3a91b20", kind: "update", cellType: "code", before: "scheduler = StepLR(opt, step_size=1, gamma=0.1)\nfor epoch in range(epochs):\n    train(epoch)", after: "scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)\nfor epoch in range(epochs):\n    train(epoch)" } },
      ],
    },
    { id: "m3", role: "user", createdAt: now - 20_000, parts: [{ type: "text", text: "Run it for 5 epochs" }] },
    { id: "m4", role: "agent", createdAt: now - 15_000, parts: [{ type: "tool", toolCallId: "t4", title: "Run cell c7f3a91b20", status: "in_progress", notebook: true }] },
  ],
};
const bridge: BridgeState = {
  conn: "connected", config: { port: 47821, token: "" }, agents: [
    { id: "claude", name: "Claude Code", available: true, builtin: true, command: "claude" },
    { id: "codex", name: "Codex", available: true, builtin: true, command: "codex" },
    { id: "gemini", name: "Gemini CLI", available: false, builtin: true, command: "gemini", reason: "Not installed" },
  ],
};
const answers: Record<string, unknown> = {
  "state.get": bridge, "notebooks.list": [{ tabId: -7, platform: "colab", title: notebook.title, place: "chrome" }],
  "tab.notebook": notebook, "chat.get": chat, "chat.open": chat, "activeTab.get": -7,
};
const host: PanelHost = {
  async request<T>(method: string) { console.log("request", method); return answers[method] as T; },
  on(_l: (e: PanelEvent) => void) { return () => {}; },
  watchTab(l) { l(-7); return () => {}; },
  async getPrefs() { return { agentId: "claude", scope: "write", review: true, notebookOnly: true } satisfies Prefs; },
  async setPrefs() {},
  async copy() {},
  async openLink() {},
};
render(<PanelHostContext.Provider value={host}><App /></PanelHostContext.Provider>, document.getElementById("root")!);
