// An inline review card for notebooks without a native one (JupyterLab, so
// Kaggle). It lives in a shadow root so neither page nor card styles leak.

import { diffLines, diffStats, withContext, type ReviewInfo } from "@ainb/protocol";

const STYLE = `
:host { all: initial; display: block; margin: 6px 0 6px 0; font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
.card { border: 1px solid var(--ainb-border, #c9d1e0); border-radius: 8px; overflow: hidden; background: var(--ainb-bg, #fff); color: var(--ainb-fg, #1d2330); }
.head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--ainb-head, #f2f5fa); border-bottom: 1px solid var(--ainb-border, #c9d1e0); }
.title { font-weight: 600; flex: 1; }
.stats { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; }
.add { color: #1a7f37; } .del { color: #cf222e; }
.diff { margin: 0; max-height: 360px; overflow: auto; font: 12px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace; }
.row { display: flex; white-space: pre; }
.row .no { flex: 0 0 34px; text-align: right; padding-right: 6px; color: #8a93a3; user-select: none; }
.row .sign { flex: 0 0 14px; user-select: none; }
.row .text { flex: 1; padding-right: 10px; }
.row.a { background: rgba(46,160,67,.14); } .row.d { background: rgba(248,81,73,.14); }
.row.s { color: #8a93a3; font-style: italic; padding: 2px 10px; }
.empty { padding: 8px 10px; color: #8a93a3; font-style: italic; }
button { font: inherit; border-radius: 6px; padding: 3px 12px; cursor: pointer; border: 1px solid transparent; }
.accept { background: #1f6feb; color: #fff; }
.accept:hover { background: #1a5fd0; }
.reject { background: transparent; color: inherit; border-color: var(--ainb-border, #c9d1e0); }
.reject:hover { background: rgba(127,127,127,.12); }
@media (prefers-color-scheme: dark) {
  .card { --ainb-bg: #161b22; --ainb-fg: #e6edf3; --ainb-head: #1f2630; --ainb-border: #36404d; }
  .add { color: #3fb950; } .del { color: #f85149; }
}
`;

const KIND_TITLE: Record<ReviewInfo["kind"], string> = {
  update: "Agent proposes a change",
  insert: "Agent proposes a new cell",
  delete: "Agent proposes deleting this cell",
};

export function createReviewCard(review: ReviewInfo, onDecide: (accept: boolean) => void): HTMLElement {
  const host = document.createElement("div");
  host.className = "ainb-review";
  host.dataset.reviewId = review.reviewId;
  // Keep the notebook from treating clicks on the card as cell selection or a
  // drag start: JupyterLab swallows the mouseup then, and the click never lands.
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "keydown", "contextmenu"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);

  const lines = diffLines(review.before, review.after);
  const { added, removed } = diffStats(lines);

  const card = el("div", "card");
  const head = el("div", "head");
  head.append(el("span", "title", KIND_TITLE[review.kind]));
  const stats = el("span", "stats");
  stats.append(el("span", "add", `+${added}`), document.createTextNode(" "), el("span", "del", `−${removed}`));
  head.append(stats);
  const accept = el("button", "accept", review.kind === "delete" ? "Delete" : "Accept") as HTMLButtonElement;
  const reject = el("button", "reject", "Reject") as HTMLButtonElement;
  accept.title = "Apply this change";
  reject.title = "Discard this change";
  // JupyterLab captures the mouseup of any press inside a cell (cell drag), so a
  // click never completes there; the press itself is the activation. Keyboard
  // activation still goes through click. Deciding twice is harmless.
  for (const [button, accepted] of [
    [accept, true],
    [reject, false],
  ] as const) {
    button.addEventListener("pointerdown", (e) => {
      if (e.button === 0) {
        e.preventDefault();
        onDecide(accepted);
      }
    });
    button.addEventListener("click", () => onDecide(accepted));
  }
  head.append(accept, reject);
  card.append(head);

  const body = el("div", "diff");
  const rows = withContext(lines, review.kind === "update" ? 3 : 1_000_000);
  if (!rows.length) body.append(el("div", "empty", "(empty cell)"));
  for (const r of rows) {
    if (r.op === "skip") {
      body.append(el("div", "row s", `⋯ ${r.count} unchanged line${r.count === 1 ? "" : "s"}`));
      continue;
    }
    const row = el("div", `row ${r.op === "add" ? "a" : r.op === "del" ? "d" : ""}`);
    row.append(
      el("span", "no", String(r.op === "add" ? (r.newNo ?? "") : (r.oldNo ?? ""))),
      el("span", "sign", r.op === "add" ? "+" : r.op === "del" ? "−" : " "),
      el("span", "text", r.text || " "),
    );
    body.append(row);
  }
  card.append(body);
  root.append(card);
  return host;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
