import { useEffect, useRef, useState } from "preact/hooks";
import { parseLaunchCommand, type AgentInfo, type AgentOption } from "@ainb/protocol";
import { client } from "./client.js";

export function AgentManager({ agents, onSaved, onRemoved, onClose }: {
  agents: AgentInfo[]; onSaved: (id: string) => void; onRemoved: (id: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const edit = (nextName: string, nextCommand: string, nextId?: string) => {
    setId(nextId); setName(nextName); setCommand(nextCommand); setError(null); setConnected(null);
  };
  const act = async (task: () => Promise<void>) => {
    setBusy(true); setError(null); setConnected(null);
    try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <dialog ref={dialog} class="agent-manager" aria-labelledby="agents-title" onCancel={onClose}>
      <div class="manager-head">
        <h1 id="agents-title">Manage ACP agents</h1>
        <button class="icon" aria-label="Close agent manager" onClick={onClose}>×</button>
      </div>
      <p class="muted">Add any installed ACP agent with its launch command. Your existing agent sign-in is reused.</p>
      <div class="manager-list">
        {agents.filter((a) => !a.builtin).map((a) => (
          <div class="manager-agent" key={a.id}>
            <div><strong>{a.name}</strong><code>{a.launchCommand ?? a.command}</code>{!a.available && <span class="notice error">{a.reason}</span>}</div>
            <button class="secondary small" disabled={busy} onClick={() => edit(a.name, a.launchCommand ?? a.command, a.id)}>Edit</button>
            <button class="secondary small" disabled={busy} onClick={() => void act(async () => {
              await client.request("agents.remove", { id: a.id });
              if (id === a.id) edit("", "");
              onRemoved(a.id);
            })}>Remove</button>
          </div>
        ))}
      </div>
      <div class="manager-presets">
        <button class="secondary small" disabled={busy} onClick={() => edit("DeepSeek Harness", "dsh --profile acp")}>DeepSeek Harness</button>
        <button class="secondary small" disabled={busy} onClick={() => edit("Claude FP", "claude-fp-acp")}>Claude FP</button>
        <button class="secondary small" disabled={busy} onClick={() => edit("", "")}>Custom agent</button>
        <button class="linkish" disabled={busy} onClick={() => void act(async () => { await client.request("agents.list", { refresh: true }); })}>Refresh</button>
      </div>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        void act(async () => {
          parseLaunchCommand(command);
          const result = await client.request<{ agent: AgentInfo }>("agents.save", { id, name, launchCommand: command });
          onSaved(result.agent.id);
        });
      }}>
        <label class="field">Name (optional)<input value={name} disabled={busy} onInput={(e) => setName(e.currentTarget.value)} placeholder="My agent" /></label>
        <label class="field">Launch command<input value={command} disabled={busy} onInput={(e) => { setCommand(e.currentTarget.value); setConnected(null); }} placeholder="dsh --profile acp" spellcheck={false} autocomplete="off" /></label>
        <p class="muted small">Use quotes around paths or arguments containing spaces. Commands run on the bridge's computer.</p>
        {error && <p class="notice error" role="alert">{error}</p>}
        {connected !== null && <p class="manager-connected" role="status">{connected}</p>}
        <div class="manager-actions">
          <button type="button" class="secondary" disabled={busy || !command.trim()} onClick={() => void act(async () => {
            parseLaunchCommand(command);
            const result = await client.request<{ name: string; options: AgentOption[] }>("agents.test", { launchCommand: command });
            const models = result.options.find((o) => o.category === "model")?.choices?.map((c) => c.name).join(", ");
            setConnected(`Connected to ${result.name}${models ? `. Models: ${models}` : ""}`);
          })}>Test connection</button>
          <button type="submit" class="primary" disabled={busy || !command.trim()}>{busy ? "Working…" : id ? "Save changes" : "Add agent"}</button>
        </div>
      </form>
    </dialog>
  );
}
