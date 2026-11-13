// Settings: the agents (OpenResearch's, which research chats use, and the
// notebook chat's), compute (machines for background runs, and the notebooks
// open in Chrome), environment variables, and the kernel environment set up on
// a notebook's machine.

import { HarnessLogo } from "@orx/components/HarnessLogo";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@orx/workspace";
import type { AcpPreset, Harness } from "@orx/api";
import type { AgentInfo } from "@ainb/protocol";
import type { KernelSetup, SettingsSection } from "./messages.js";
import { ComputeTab } from "./compute.js";
import { ResearchGate } from "./root.js";
import { useNotebooks } from "./sidebar.js";
import { hostRequest } from "./tunnel.js";
import { Banner, Button, Icon, IconButton, errorText } from "./ui.js";

const SECTIONS: [SettingsSection, string][] = [["agents", "Agents"], ["compute", "Compute"], ["environment", "Environment"], ["kernel", "Kernel Environment"]];

export function Settings({ section: initial }: { section?: SettingsSection }) {
  const [section, setSection] = useState<SettingsSection>(initial ?? "agents");
  useEffect(() => { if (initial) setSection(initial); }, [initial]);
  return (
    <div className="settings">
      <nav className="toc" aria-label="Settings sections">
        {SECTIONS.map(([k, l]) => <button type="button" key={k} className={section === k ? "on" : ""} aria-current={section === k} onClick={() => setSection(k)}>{l}</button>)}
      </nav>
      <div className="settings-body">
        {section === "agents" && <Agents />}
        {section === "compute" && <Compute onOpenEnvironment={() => setSection("environment")} />}
        {section === "environment" && <ResearchGate><Environment /></ResearchGate>}
        {section === "kernel" && <Kernel />}
      </div>
    </div>
  );
}

function Item({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="sitem"><div className="k">{label}</div>{hint && <div className="muted small">{hint}</div>}{children}</div>;
}

// ------------------------------------------------------------------ agents

function Agents() {
  return (
    <>
      <h2>Agents</h2>
      <p className="muted">Coding agents that talk ACP. Research chats run through OpenResearch; notebook chats run through the bridge. Adding an agent here adds it to both.</p>
      <ResearchGate compact><ResearchAgents /></ResearchGate>
      <NotebookAgents />
    </>
  );
}

function ResearchAgents() {
  const { queries, api } = useWorkspace();
  const client = useQueryClient();
  const harnesses = useQuery(queries.getHarnessesQuery());
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: queries.getHarnessesQuery().queryKey });
  return (
    <section className="sec">
      <div className="sec-head"><h3>Research chats</h3><Button small onClick={() => setAdding(true)}><Icon name="plus" /> Add agent</Button><IconButton icon="refresh" title="Check again" onClick={() => void queries.refreshHarnesses?.().then(refresh, refresh)} /></div>
      {adding && <AddAgent onDone={() => { setAdding(false); refresh(); }} />}
      {harnesses.isError && <Banner tone="error">{errorText(harnesses.error)}</Banner>}
      <div className="cards-list">
        {(harnesses.data ?? []).map((h: Harness) => {
          const detail = !h.installed ? "Not installed" : h.installBroken ? "Installed, but does not start" : h.authenticated ? [h.account ?? "Signed in", h.plan].filter(Boolean).join(" · ") : h.authState === "needsLogin" ? "Not signed in" : h.agentNote ?? "Ready";
          return (
            <div key={h.id} className="harn">
              <div className="hrow" role="button" tabIndex={0} onClick={() => setOpen(open === h.id ? null : h.id)}>
                <span className="hlogo"><HarnessLogo harness={h.id} logo={h.logo} size={16} /></span>
                <span className="nm"><b>{h.name}</b><small className={h.agentReady ? "" : "warn"}>{detail}</small></span>
                {h.agentReady && <span className="pill ok">Ready</span>}
                <Icon name={open === h.id ? "chev-d" : "chev-r"} />
              </div>
              {open === h.id && (
                <dl className="hdet">
                  {h.binPath && <><dt>Program</dt><dd className="mono">{h.binPath}</dd></>}
                  {h.version && <><dt>Version</dt><dd>{h.version}</dd></>}
                  <dt>Sign-in</dt><dd>{h.authenticated ? `Signed in${h.authMethod ? ` (${h.authMethod})` : ""}` : h.authState === "needsLogin" ? "Needed" : "Not needed or unknown"}</dd>
                  {h.org && <><dt>Organization</dt><dd>{h.org}</dd></>}
                  <dt>Models</dt><dd>{h.models.length ? `${h.models.length} available` : "—"}</dd>
                  {h.agentNote && <><dt>Note</dt><dd>{h.agentNote}</dd></>}
                  {h.setupUrl && <dd className="span"><a href="#" onClick={(e) => { e.preventDefault(); void hostRequest("link.open", { url: h.setupUrl }); }}>Setup instructions</a></dd>}
                  {h.id.startsWith("acp:") && <dd className="span"><Button small onClick={() => void api.removeAcpHarness(h.id).then(refresh, (e) => hostRequest("message", { level: "error", text: errorText(e) }))}>Remove</Button></dd>}
                </dl>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Split a pasted command line into the program and its arguments (quotes keep spaces). */
function splitCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

function AddAgent({ onDone }: { onDone: () => void }) {
  const { api } = useWorkspace();
  const [presets, setPresets] = useState<AcpPreset[]>([]);
  const [preset, setPreset] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listAcpPresets().then(setPresets, () => {}); }, []);
  const definition = () => {
    const [executable, ...args] = splitCommand(command.trim());
    return { name: name.trim() || executable || "Agent", executable: executable ?? "", arguments: args };
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await api.testAcpHarness(definition());
      setResult({ ok: r.status === "ok" || r.status === "ready", text: r.status === "ok" || r.status === "ready" ? `Connected${r.agentInfo?.version ? ` · ${r.agentInfo.version}` : ""}` : r.status });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    try {
      const d = definition();
      await api.saveAcpHarness(d);
      // The notebook chats get it too.
      await hostRequest("agents.save", { name: d.name, launchCommand: command.trim() }).catch(() => {});
      onDone();
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog">
      <h3>Connect a coding agent</h3>
      <p className="muted small">Connect an installed coding agent through ACP.</p>
      <label className="field"><span className="lab">Coding agent</span>
        <select className="inp" value={preset} onChange={(e) => {
          const p = presets.find((x) => x.id === e.currentTarget.value);
          setPreset(e.currentTarget.value);
          if (p) { setName(p.name); setCommand([p.executable, ...p.arguments].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")); }
        }}>
          <option value="">Other (custom setup)</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="field"><span className="lab">Name</span><input className="inp" value={name} onInput={(e) => setName(e.currentTarget.value)} /></label>
      <label className="field"><span className="lab">Launch command</span><input className="inp mono" value={command} placeholder="kimi acp" onInput={(e) => setCommand(e.currentTarget.value)} />
        <span className="muted small">Paste the complete command from your agent's setup instructions.</span></label>
      {result && <p className={result.ok ? "ok-text" : "err-text"}>{result.text}</p>}
      <div className="row end"><Button disabled={busy || !command.trim()} onClick={() => void test()}>Test connection</Button><Button onClick={onDone}>Cancel</Button><Button primary disabled={busy || !command.trim()} onClick={() => void connect()}>Connect</Button></div>
    </div>
  );
}

function NotebookAgents() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const load = () => hostRequest<{ agents: AgentInfo[] }>("agents.list", { refresh: true }).then((r) => setAgents(r.agents), () => setAgents([]));
  useEffect(() => { void load(); }, []);
  return (
    <section className="sec">
      <div className="sec-head"><h3>Notebook chats</h3></div>
      <div className="rows">
        {(agents ?? []).map((a) => (
          <div key={a.id} className="srow">
            <span className="nm"><b>{a.name}</b><small className="mono">{a.available ? a.command : a.reason}</small></span>
            {a.available ? <span className="pill ok">Ready</span> : <span className="pill bad">Not found</span>}
            {!a.builtin && <IconButton icon="trash" title="Remove" onClick={() => void hostRequest("agents.remove", { id: a.id }).then(load)} />}
          </div>
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ compute

function Compute({ onOpenEnvironment }: { onOpenEnvironment: () => void }) {
  const notebooks = useNotebooks();
  return (
    <>
      <h2>Compute</h2>
      <p className="muted">Where work runs. Notebook chats work on the notebook's own machine; research chats send runs to the machines below.</p>
      <section className="sec">
        <h3>Interactive · notebooks open in Chrome</h3>
        <div className="cards">
          {(["colab", "kaggle"] as const).map((p) => {
            const open = notebooks.filter((n) => n.platform === p && n.place === "chrome");
            return (
              <div key={p} className="ccard static">
                <span className={`lg lg-${p}`}>{p === "colab" ? "Co" : "K"}</span>
                <b>{p === "colab" ? "Colab" : "Kaggle notebook"}</b>
                <span className="muted small">{p === "colab" ? "Free GPU in a Colab tab. The terminal waits while a cell runs." : "A Kaggle tab. Notebook and terminal run side by side."}</span>
                <span className="cf"><span>{open.length ? `${open.length} tab${open.length > 1 ? "s" : ""} open` : "Open a tab in Chrome"}</span></span>
              </div>
            );
          })}
        </div>
      </section>
      <h3>Background runs · OpenResearch</h3>
      <ResearchGate compact><ComputeTab onOpenEnvironment={onOpenEnvironment} /></ResearchGate>
    </>
  );
}

// ------------------------------------------------------------------ environment

function Environment() {
  const { queries, api } = useWorkspace();
  const client = useQueryClient();
  const vars = useQuery(queries.getEnvVarsQuery());
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reload = () => void client.invalidateQueries({ queryKey: queries.getEnvVarsQuery().queryKey });
  const save = async () => {
    setError(null);
    try { await api.setEnvVar(key.trim(), value); setKey(""); setValue(""); reload(); } catch (e) { setError(errorText(e)); }
  };
  return (
    <>
      <h2>Environment</h2>
      <p className="muted">Variables available to runs and the research agent (API keys, tokens). Secret values stay masked.</p>
      <div className="tblwrap">
        <table className="tbl">
          <tbody>
            {(vars.data ?? []).map((v) => (
              <tr key={v.key}>
                <td className="mono">{v.key}</td>
                <td className="mono muted">{v.value ?? v.maskedValue}{v.inProcessEnv && <span className="pill">Overridden by env</span>}</td>
                <td className="act"><IconButton icon="trash" title={`Remove ${v.key}`} onClick={() => void api.deleteEnvVar(v.key).then(reload, (e) => setError(errorText(e)))} /></td>
              </tr>
            ))}
            <tr>
              <td><input className="inp mono" placeholder="MY_API_KEY" value={key} onInput={(e) => setKey(e.currentTarget.value)} /></td>
              <td><input className="inp mono" type="password" placeholder="value" value={value} onInput={(e) => setValue(e.currentTarget.value)} /></td>
              <td className="act"><Button small primary disabled={!key.trim()} onClick={() => void save()}>Save</Button></td>
            </tr>
          </tbody>
        </table>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
    </>
  );
}

// ------------------------------------------------------------------ kernel environment

function Kernel() {
  const notebooks = useNotebooks().filter((n) => n.place === "chrome");
  const [setup, setSetup] = useState<KernelSetup | null>(null);
  const [saved, setSaved] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { hostRequest<KernelSetup>("kernel.get").then(setSetup, () => {}); }, []);
  useEffect(() => { if (target === null && notebooks[0]) setTarget(notebooks[0].tabId); }, [notebooks.length]);
  if (!setup) return null;
  const update = (patch: Partial<KernelSetup>) => {
    const next = { ...setup, ...patch };
    setSetup(next);
    setSaved(false);
    void hostRequest("kernel.set", next).then(() => setSaved(true));
  };
  const run = async () => {
    if (target === null) return;
    setBusy(true);
    setOutput("");
    try {
      const r = await hostRequest<{ output: string; exitCode: number | null; running: boolean }>("kernel.run", { tabId: target });
      const end = r.running ? 'Still running on the machine (terminal session "setup"); the agent can follow it there.' : r.exitCode === 0 ? "Finished." : `Exited with code ${r.exitCode}.`;
      setOutput(`${r.output}\n${end}`);
    } catch (e) {
      setOutput(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2>Kernel Environment</h2>
      <p className="muted">Colab and Kaggle forget everything between sessions. This script runs in the notebook machine's terminal to set it up again.</p>
      <Item label="Setup script" hint="Shell commands, run before the agent starts work. Example: clone your repository and install its requirements.">
        <textarea className="inp mono script" value={setup.script} placeholder={"git clone https://github.com/you/repo /content/repo\npip install -q -r /content/repo/requirements.txt"} onInput={(e) => update({ script: e.currentTarget.value })} />
      </Item>
      <Item label="Run on attach">
        <label className="chk"><input type="checkbox" checked={setup.runOnAttach} onChange={(e) => update({ runOnAttach: e.currentTarget.checked })} /> Run the setup script when a Colab or Kaggle notebook connects to the bridge</label>
        <div className="row"><label className="chk"><input type="checkbox" checked={setup.colab} onChange={(e) => update({ colab: e.currentTarget.checked })} /> Colab</label><label className="chk"><input type="checkbox" checked={setup.kaggle} onChange={(e) => update({ kaggle: e.currentTarget.checked })} /> Kaggle</label></div>
      </Item>
      {saved && <p className="muted small">Saved.</p>}
      <Item label="Run now">
        {notebooks.length ? (
          <div className="row">
            <select className="inp narrow" value={target ?? ""} onChange={(e) => setTarget(Number(e.currentTarget.value))}>
              {notebooks.map((n) => <option key={n.tabId} value={n.tabId}>{n.title}</option>)}
            </select>
            <Button primary disabled={busy || !setup.script.trim()} onClick={() => void run()}><Icon name="play" /> {busy ? "Running…" : "Run setup"}</Button>
          </div>
        ) : <p className="muted small">Open a Colab or Kaggle notebook in Chrome to run it now.</p>}
        {output !== null && <pre className="log">{output}</pre>}
      </Item>
    </>
  );
}
