// Where an exercise runs: a notebook the learner opened in Chrome (Kaggle),
// which the bridge fills with the exercise's cells. The learner works in
// VS Code's copy of it; the code runs, and is judged, on the notebook's
// machine. A notebook holds one exercise at a time: putting another one in
// keeps the learner's work of the first (and its conversation) for later.

import type { CellInfo, MentorKind, MentorPlace, NotebookInfo, NotebookOp, NotebookOpResults } from "@ainb/protocol";
import { toIpynb } from "../notebook/ipynb.js";
import type { ChatStore } from "../store.js";
import type { Mentor } from "./index.js";
import { paperEventId } from "./model.js";
import { exerciseIn, foreignCells, learnerWork, paperIn } from "./notebook.js";
import { workshopCells } from "./workshop.js";

export interface PlaceHost {
  /** Notebooks open in Chrome, by tab. */
  notebooks(): ReadonlyMap<number, NotebookInfo>;
  op<K extends NotebookOp["op"]>(tabId: number, op: Extract<NotebookOp, { op: K }>, timeoutMs?: number): Promise<NotebookOpResults[K]>;
  /** Close the chats on a tab (their transcripts are saved); the editor opens a chat again by itself. */
  closeChats(tabId: number): void;
  chats: Pick<ChatStore, "move" | "hasTranscript">;
  log(message: string): void;
}

/** The learner must say yes before their own cells are replaced. */
export class ReplaceRefused extends Error {}

/** Where a conversation about an attempt waits while its notebook holds another exercise. */
export function attemptChatKey(attemptId: string): string {
  return `mentor:${attemptId}`;
}

/** Where a paper workshop's conversation waits while no notebook is its workshop. */
export function workshopChatKey(paperId: string): string {
  return `mentor-paper:${paperId}`;
}

/** The hidden chat that writes a paper's exercises keeps its transcript here (for debugging). */
export function authorChatKey(paperId: string): string {
  return `mentor-author:${paperId}`;
}

const READ_MS = 20_000;
const EDIT_MS = 20_000;

export class MentorPlaces {
  /** One write at a time per tab. */
  private readonly busy = new Map<number, Promise<unknown>>();

  constructor(private readonly mentor: Mentor, private readonly host: PlaceHost) {}

  tabOf(key: string): number | undefined {
    for (const [tabId, info] of this.host.notebooks()) if (info.key === key) return tabId;
    return undefined;
  }

  /** The Chrome tab whose notebook holds the unfinished attempt of the exercise, if one does. */
  holding(exerciseId: string | undefined, kind: MentorKind): number | undefined {
    let id: string;
    try {
      id = this.mentor.exerciseFor(exerciseId, kind);
    } catch {
      return undefined;
    }
    const key = this.mentor.openAttempt(id, kind)?.notebook;
    return key ? this.tabOf(key) : undefined;
  }

  /** The notebooks open in Chrome, with what they hold. A notebook that does not answer is left out. */
  async list(): Promise<MentorPlace[]> {
    const out: MentorPlace[] = [];
    await Promise.all([...this.host.notebooks()].map(async ([tabId, info]) => {
      if (!info.key) return;
      let cells: CellInfo[];
      try {
        cells = (await this.host.op(tabId, { op: "get_cells", summary: true }, READ_MS)).cells;
      } catch (e) {
        this.host.log(`Mentor: could not read ${info.title || "a notebook"}: ${(e as Error).message}`);
        return;
      }
      const a = this.mentor.attemptIn(info.key);
      const held = a && exerciseIn(cells) === a.exerciseId ? a : undefined;
      const ws = this.mentor.workshopIn(info.key);
      const workshop = ws && paperIn(cells) === ws ? ws : undefined;
      out.push({
        tabId,
        title: info.title,
        platform: info.platform,
        kernel: info.kernel,
        key: info.key,
        ...(held ? { holds: { attemptId: held.attemptId, exerciseId: held.exerciseId, title: this.mentor.catalog.exercise(held.exerciseId)?.title ?? held.exerciseId, kind: held.kind, done: !!held.doneAt } } : {}),
        foreignCells: foreignCells(cells),
        ...(workshop ? { workshop: { paperId: workshop, title: this.mentor.paperPackage(workshop)?.info.title ?? workshop } } : {}),
      });
    }));
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * Put an exercise (today's when none is named, or its unfinished attempt)
   * in the notebook of a Chrome tab. A notebook that already holds the
   * attempt is left as it is.
   */
  async start(p: { exerciseId?: string; kind?: MentorKind; tabId?: number; replace?: boolean }): Promise<{ attemptId: string; exerciseId: string; tabId: number; resumed: boolean }> {
    // No notebook named: the one that holds the unfinished attempt, when it is open.
    const tabId = p.tabId ?? this.holding(p.exerciseId, p.kind ?? "learn");
    if (tabId === undefined) throw new Error("Chọn một notebook đang mở trong Chrome để làm bài.");
    const before = this.busy.get(tabId);
    if (before) throw new Error("Notebook này đang được chép đề, đợi một chút.");
    const run = this.put(tabId, p);
    this.busy.set(tabId, run);
    try {
      return await run;
    } finally {
      this.busy.delete(tabId);
    }
  }

  private async put(tabId: number, p: { exerciseId?: string; kind?: MentorKind; replace?: boolean }) {
    const info = this.host.notebooks().get(tabId);
    if (!info?.key) throw new Error("Notebook này không còn mở trong Chrome (hoặc chưa nối với bridge).");
    const key = info.key;
    const cells = (await this.host.op(tabId, { op: "get_cells" }, READ_MS)).cells;
    const held = this.mentor.attemptIn(key);
    const heldHere = held && exerciseIn(cells) === held.exerciseId ? held : undefined;
    const foreign = foreignCells(cells);
    if (foreign > 0 && !p.replace) {
      throw new ReplaceRefused(`Notebook "${info.title}" đang có ${foreign} cell của bạn. Chép đề vào sẽ thay toàn bộ (bản cũ được lưu về máy).`);
    }
    const { attemptId, exerciseId, resumed } = this.mentor.begin(p.exerciseId, p.kind ?? "learn");
    if (heldHere?.attemptId === attemptId) return { attemptId, exerciseId, tabId, resumed: true };

    // What the notebook has now is kept: the learner's work in another exercise, or their own notebook.
    if (heldHere) this.mentor.store.saveWork(heldHere.attemptId, learnerWork(cells));
    if (foreign > 0) {
      const file = this.mentor.store.backup(info.title, toIpynb(cells, info.language || "python"));
      this.host.log(`Mentor: saved "${info.title}" to ${file} before writing an exercise into it.`);
    }

    // Conversations: the notebook's goes away with what it held; this attempt's comes back.
    this.host.closeChats(tabId);
    const ws = this.mentor.workshopIn(key);
    const away = held ? attemptChatKey(held.attemptId) : ws ? workshopChatKey(ws) : `mentor-replaced:${key}:${Date.now()}`;
    if (this.host.chats.hasTranscript(key)) this.host.chats.move(key, away);
    const a = this.mentor.attempt(attemptId)!;
    if (a.notebook && a.notebook !== key) {
      // The attempt leaves the notebook it was in; that notebook's chat is no longer about it.
      const other = this.tabOf(a.notebook);
      if (other !== undefined) this.host.closeChats(other);
      if (this.host.chats.hasTranscript(a.notebook)) this.host.chats.move(a.notebook, attemptChatKey(attemptId));
    }
    if (this.host.chats.hasTranscript(attemptChatKey(attemptId))) this.host.chats.move(attemptChatKey(attemptId), key);

    await this.rewrite(tabId, cells, this.mentor.cellsFor(attemptId));
    this.mentor.record({ t: "load", attemptId, notebook: key });
    // Chats opened on the tab while it was written are closed again, to open as the exercise's.
    this.host.closeChats(tabId);
    return { attemptId, exerciseId, tabId, resumed };
  }

  /**
   * Make the notebook of a Chrome tab a paper's workshop (or move the
   * workshop there): what it held is kept as for an exercise, the workshop's
   * conversation follows it.
   */
  async openWorkshop(paperId: string, tabId: number, replace = false): Promise<{ paperId: string; tabId: number }> {
    if (this.busy.get(tabId)) throw new Error("Notebook này đang được chép, đợi một chút.");
    const run = (async () => {
      const info = this.host.notebooks().get(tabId);
      if (!info?.key) throw new Error("Notebook này không còn mở trong Chrome (hoặc chưa nối với bridge).");
      const key = info.key;
      const pkg = this.mentor.paperPackage(paperId);
      if (!pkg) throw new Error(`Không có paper ${paperId}.`);
      const cells = (await this.host.op(tabId, { op: "get_cells" }, READ_MS)).cells;
      const ws = this.mentor.workshopIn(key);
      if (ws === paperId && paperIn(cells) === paperId) return { paperId, tabId };
      const held = this.mentor.attemptIn(key);
      const heldHere = held && exerciseIn(cells) === held.exerciseId ? held : undefined;
      const foreign = foreignCells(cells);
      if (foreign > 0 && !replace) throw new ReplaceRefused(`Notebook "${info.title}" đang có ${foreign} cell của bạn. Biến nó thành xưởng paper sẽ thay toàn bộ (bản cũ được lưu về máy).`);
      if (heldHere) this.mentor.store.saveWork(heldHere.attemptId, learnerWork(cells));
      if (foreign > 0) {
        const file = this.mentor.store.backup(info.title, toIpynb(cells, info.language || "python"));
        this.host.log(`Mentor: saved "${info.title}" to ${file} before making it a workshop.`);
      }
      this.host.closeChats(tabId);
      const away = held ? attemptChatKey(held.attemptId) : ws ? workshopChatKey(ws) : `mentor-replaced:${key}:${Date.now()}`;
      if (this.host.chats.hasTranscript(key)) this.host.chats.move(key, away);
      const before = this.mentor.workshopOf(paperId);
      if (before && before !== key) {
        const other = this.tabOf(before);
        if (other !== undefined) this.host.closeChats(other);
        if (this.host.chats.hasTranscript(before)) this.host.chats.move(before, workshopChatKey(paperId));
      }
      if (this.host.chats.hasTranscript(workshopChatKey(paperId))) this.host.chats.move(workshopChatKey(paperId), key);
      await this.rewrite(tabId, cells, workshopCells(pkg.info).map((c, index) => ({ ...c, id: `mentor-paper-${index}`, index, executionCount: null, outputs: [] })));
      this.mentor.record({ t: "workshop", attemptId: paperEventId(paperId), paperId, notebook: key });
      // A paper put on the shelf by easy-read: its workshop starts now, at reading it.
      if (pkg.info.origin === "yours" && pkg.info.status === "shelved") {
        this.mentor.shelf.write(paperId, { status: "reading" });
        this.mentor.reloadPapers();
      }
      this.host.closeChats(tabId);
      return { paperId, tabId };
    })();
    this.busy.set(tabId, run);
    try {
      return await run;
    } finally {
      this.busy.delete(tabId);
    }
  }

  /** Every cell out, the exercise's in, as the learner's own edits (not the agent's). */
  private async rewrite(tabId: number, old: CellInfo[], cells: CellInfo[]): Promise<void> {
    for (const c of [...old].reverse()) {
      await this.host.op(tabId, { op: "delete_cell", cellId: c.id, review: false, byUser: true }, EDIT_MS);
    }
    let index = 0;
    for (const c of cells) {
      await this.host.op(tabId, { op: "insert_cell", index, cellType: c.type, source: c.source, review: false, byUser: true }, EDIT_MS);
      index++;
    }
  }

  /**
   * Kaggle moves a notebook to a new address when it is renamed: the tab now
   * answers with another key. If it still holds the exercise the old key
   * held, the exercise (and its conversation) follows the new key.
   */
  async followRename(tabId: number, from: string, to: string): Promise<boolean> {
    const ws = this.mentor.workshopIn(from);
    if (ws && !this.mentor.workshopIn(to) && !this.mentor.attemptIn(to)) {
      let cells: CellInfo[];
      try {
        cells = (await this.host.op(tabId, { op: "get_cells", summary: true }, READ_MS)).cells;
      } catch {
        return false;
      }
      if (paperIn(cells) !== ws || this.host.notebooks().get(tabId)?.key !== to) return false;
      this.host.closeChats(tabId);
      if (this.host.chats.hasTranscript(from) && !this.host.chats.hasTranscript(to)) this.host.chats.move(from, to);
      this.mentor.record({ t: "workshop", attemptId: paperEventId(ws), paperId: ws, notebook: to });
      return true;
    }
    const a = this.mentor.attemptIn(from);
    if (!a || this.mentor.attemptIn(to)) return false;
    let cells: CellInfo[];
    try {
      cells = (await this.host.op(tabId, { op: "get_cells", summary: true }, READ_MS)).cells;
    } catch {
      return false;
    }
    if (exerciseIn(cells) !== a.exerciseId || this.host.notebooks().get(tabId)?.key !== to) return false;
    this.host.log(`Mentor: the notebook ${from} now answers as ${to} (renamed); its exercise follows it.`);
    this.host.closeChats(tabId);
    if (this.host.chats.hasTranscript(from) && !this.host.chats.hasTranscript(to)) this.host.chats.move(from, to);
    this.mentor.record({ t: "load", attemptId: a.attemptId, notebook: to });
    return true;
  }
}
