// Building blocks the compute screens share, in VS Code's look. OpenResearch's
// own settings page builds on Tailwind and its component kit; these are the
// same controls (status badge, loading row, labeled field, switch, dialog, key
// and value list) as small elements styled in studio.css.

import { useEffect, useId, type ComponentProps, type ReactNode } from "react";
import { m } from "@orx/paraglide/messages.js";
import { hostRequest } from "./tunnel.js";
import { Icon } from "./ui.js";

export type BadgeTone = "success" | "warning" | "error" | "neutral";

/** OpenResearch's Badge: a small status pill. */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`pill${tone === "success" ? " ok" : tone === "error" ? " bad" : tone === "warning" ? " warn-pill" : ""}`}>{children}</span>;
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function LoadingRow({ children }: { children: ReactNode }) {
  return <div className="loading-row muted">{children}</div>;
}

/** A labeled form control: label on top, optional hint under the control. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <label className="field"><span className="lab">{label}</span>{children}{hint && <span className="muted small">{hint}</span>}</label>;
}

export function TextInput(props: ComponentProps<"input">) {
  return <input {...props} className={`inp${props.className ? ` ${props.className}` : ""}`} />;
}

/** Key and value rows (OpenResearch's "details" grid). */
export function Details({ children }: { children: ReactNode }) {
  return <dl className="kv">{children}</dl>;
}

export function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

/** A status row: label on the left, badge or value on the right. */
export function StatusRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="status-row"><span className="muted">{label}</span><span>{children}</span></div>;
}

export function Switch({ checked, onChange, disabled, labelledBy, describedBy }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; labelledBy?: string; describedBy?: string }) {
  return (
    <button type="button" role="switch" className={`switch${checked ? " on" : ""}`} aria-checked={checked} aria-labelledby={labelledBy} aria-describedby={describedBy} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

/** A link that opens in the user's browser (a webview cannot navigate away). */
export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} onClick={(e) => { e.preventDefault(); void hostRequest("link.open", { url: href }); }}>{children}</a>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="err-text compute-error" role="alert">{children}</p>;
}

/** A failed check, with the red rule on its left (OpenResearch's diagnostic). */
export function Diagnostic({ children }: { children: ReactNode }) {
  return <p className="diagnostic">{children}</p>;
}

/** A modal over the page: Escape or a click outside closes it (unless `locked`). */
export function Modal({ title, logo, onClose, locked, children }: { title: string; logo?: ReactNode; onClose: () => void; locked?: boolean; children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !locked) onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [locked, onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="row between modal-head">
          <div className="row">{logo}<h3 id={id}>{title}</h3></div>
          <button type="button" className="ib" title={m.app_close_panel()} aria-label={m.app_close_panel()} disabled={locked} onClick={onClose}><Icon name="close" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Two-step confirm in the page (OpenResearch's confirm dialog). */
export function ConfirmModal({ title, text, confirm, destructive, onConfirm, onCancel }: { title: string; text: string; confirm: string; destructive?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{text}</p>
      <div className="row end">
        <button type="button" className="btn" onClick={onCancel}>{m.common_cancel()}</button>
        <button type="button" className={`btn primary${destructive ? " danger" : ""}`} onClick={onConfirm}>{confirm}</button>
      </div>
    </Modal>
  );
}
