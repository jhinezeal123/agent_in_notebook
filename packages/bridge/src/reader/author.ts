// The author (E.4.2): a hidden chat that prepares a paper in the background,
// one step ahead of the reader, apart from the tutor (there is no kernel to
// share, so the reader keeps asking the tutor meanwhile). Its tasks, one at a
// time: the paper's map when the reader chooses a goal; a unit's checkpoint
// when the reader reaches the unit before it. Work the passes prepare ahead
// runs on its own only in mode "auto" (reader.json); by default ("ask") it
// waits as a proposal until the reader presses Soạn, and Dừng is kept on disk
// so nothing restarts on its own. Everything it writes goes
// through the schemas and checks of items.ts and lint.ts; a checkpoint's
// questions are then solved blind by the checker (checker.ts), and those it
// answers otherwise go back to the author, twice at most, then are dropped.

import { z } from "zod";
import type { ReaderAgentMode, ReaderAuthorView, ReaderWidgetRequest } from "@ainb/protocol";
import type { ChatPort, ChatRole, RoleTurn } from "../chat-role.js";
import type { AuthorChat } from "../mentor/workshop.js";
import { callTool, tool, type ToolContext, type ToolDef, type ToolResult } from "../notebook/tools.js";
import { READER_SETTINGS } from "./chat.js";
import { checkerTask, ReaderCheckerRole, verdictOf } from "./checker.js";
import type { ReaderHub } from "./index.js";
import { ItemSchema, itemId, MapSchema, PackSchema, pretestId, type ItemInput, type MapInput, type PackInput, type ReaderItem, type ReaderMap, type ReaderPack, type ReaderUnitDef } from "./items.js";
import { atLeastApply, lintItem, lintMapPart, lintPack, nearDuplicate } from "./lint.js";
import { pagedDoc, type ReaderAuthorQueue, type ReaderPasses } from "./passes.js";
import { READER_TOOLS, type ReaderToolContext, type ReaderToolHost } from "./tools.js";
import { decodeWidgetTool, WidgetToolSchema, type WidgetSchema } from "./widgets.js";
import { DeepSchema } from "./deep.js";
import { CardBatchSchema } from "./cards.js";
import { measureRules } from "./eval.js";

export interface ReaderAuthorHost {
  /** A hidden chat about the paper, taking this role; shown nowhere. */
  chat(paperId: string, role: ChatRole, kind: "author" | "checker"): AuthorChat;
  log?(m: string): void;
  /** When the author may run, and the checker with it (reader.json). Absent: on its own, checker on, two fix rounds. */
  settings?(): ReaderAgentSettings;
}

export interface ReaderAgentSettings {
  mode: ReaderAgentMode;
  checker: boolean;
  rounds: number;
}

const AUTO: ReaderAgentSettings = { mode: "auto", checker: true, rounds: 2 };

export type ReaderTask = { kind: "map" } | { kind: "unit"; unit: string } | { kind: "widget"; request: ReaderWidgetRequest } | { kind: "deep" } | { kind: "cards" };
type Task = ReaderTask;

interface Queue {
  tasks: Task[];
  current?: Task;
  abort?: AbortController;
  state: ReaderAuthorView["state"];
  note?: string;
  /** Tasks that could not be done, and why (tried again on "Soạn lại"). */
  failed: Map<string, { task: Task; why: string }>;
  /** Tasks waiting for the reader's click (mode "ask", or after Dừng). */
  proposed: Map<string, Task>;
}

interface Draft {
  pack: PackInput;
  items: ReaderItem[];
  /** Items written or replaced since the last check. */
  changed: Set<string>;
}

/** Turns the author gets for a task before it counts as failed. */
const TURNS = 3;
const taskKey = (t: Task) => t.kind === "unit" ? `unit:${t.unit}` : t.kind === "widget" ? `widget:${t.request.id}` : t.kind;
/** A task the reader can start by its key alone (a widget needs its request: only from a proposal). */
const taskFromKey = (key: string): Task | undefined => key === "map" || key === "deep" || key === "cards" ? { kind: key } : key.startsWith("unit:") && key.length > 5 ? { kind: "unit", unit: key.slice(5) } : undefined;

export class ReaderAuthor implements ReaderAuthorQueue {
  private readonly queues = new Map<string, Queue>();
  private readonly drafts = new Map<string, Draft>();
  passes!: ReaderPasses;

  constructor(private readonly hub: ReaderHub, private readonly host: () => ReaderAuthorHost | undefined) {}

  // ------------------------------------------------------------------ the queue

  /**
   * A task for the author. `user`: the reader asked for it (a click), so it
   * runs now; otherwise (the passes preparing ahead) it runs on its own only
   * in mode "auto" and when the reader has not pressed Dừng, else it waits as
   * a proposal the reader can start. In mode "off" nothing runs.
   */
  enqueue(paperId: string, task: Task, user = false): void {
    const q = this.queue(paperId);
    const key = taskKey(task);
    if ((q.current && taskKey(q.current) === key) || q.tasks.some((t) => taskKey(t) === key)) return;
    if (this.done(paperId, task)) {
      if (q.proposed.delete(key)) this.hub.touch(paperId);
      return;
    }
    // No agent to write with (a hub without one): the request stays, as before.
    if (!this.host()) return;
    const s = this.settings();
    if (s.mode === "off") {
      if (user) throw new Error("Agent nền đang tắt trong cài đặt Easy-read: bật lại (Hỏi trước hoặc Tự động) để soạn.");
      return;
    }
    if (!user) {
      if (q.failed.has(key)) return;
      if (s.mode === "ask" || this.stopped(paperId)) {
        if (!q.proposed.has(key)) {
          q.proposed.set(key, task);
          this.hub.touch(paperId);
        }
        return;
      }
    } else {
      q.failed.delete(key);
      if (this.stopped(paperId)) this.setStopped(paperId, false);
    }
    q.proposed.delete(key);
    // The map first: the checkpoints use its concepts.
    if (task.kind === "map") q.tasks.unshift(task);
    else q.tasks.push(task);
    if (!q.current) void this.run(paperId);
    else this.hub.touch(paperId);
  }

  /** The reader pressed Soạn on a proposal ("all": every one), or on a unit's card. */
  start(paperId: string, key: string): void {
    const q = this.queue(paperId);
    if (key === "all") {
      const all = [...q.proposed.values()];
      if (!all.length) throw new Error("Không có việc nào đang chờ soạn.");
      for (const task of all) this.enqueue(paperId, task, true);
      return;
    }
    const task = q.proposed.get(key) ?? q.failed.get(key)?.task ?? taskFromKey(key);
    if (!task) throw new Error(`Không rõ việc soạn "${key}".`);
    this.enqueue(paperId, task, true);
  }

  /** Dừng: the work in hand goes back to proposals, and nothing starts on its own for this paper until the reader starts something (kept on disk). */
  stop(paperId: string): void {
    const q = this.queue(paperId);
    for (const task of [...(q.current ? [q.current] : []), ...q.tasks]) q.proposed.set(taskKey(task), task);
    q.tasks = [];
    this.setStopped(paperId, true);
    q.abort?.abort();
    this.hub.touch(paperId);
  }

  /** The tasks that failed, again; nothing failed: every proposal (the reader pressed Soạn lại). */
  retry(paperId: string): void {
    const q = this.queue(paperId);
    const again = [...q.failed.values()].map((f) => f.task);
    q.failed.clear();
    if (q.state !== "running") q.state = "idle";
    if (this.stopped(paperId)) this.setStopped(paperId, false);
    for (const t of again) this.enqueue(paperId, t, true);
    if (!again.length) {
      // Nothing failed: what the reader is at, again (a stop left it undone).
      this.passes.prepare(paperId);
      for (const t of [...q.proposed.values()]) this.enqueue(paperId, t, true);
      this.hub.touch(paperId);
    }
  }

  status(paperId: string): ReaderAuthorView {
    const q = this.queue(paperId);
    const s = this.settings();
    const failed = [...q.failed.values()];
    const proposals = [...q.proposed.entries()]
      .filter(([, task]) => !this.done(paperId, task))
      .map(([key, task]) => ({ key, label: this.taskLabel(paperId, task), maxTurns: this.maxTurns(task, s) }));
    return {
      state: q.current ? "running" : this.stopped(paperId) ? "stopped" : q.state === "stopped" ? "idle" : q.state,
      ...(q.current ? { task: this.taskLabel(paperId, q.current) } : {}),
      ...(q.note ? { note: q.note } : {}),
      ...(failed.length && !q.current ? { error: failed.map((f) => `${this.taskLabel(paperId, f.task)}: ${f.why}`).join(" · ") } : {}),
      queued: q.tasks.length,
      mode: s.mode,
      ...(proposals.length ? { proposals } : {}),
    };
  }

  unitState(paperId: string, unit: string): { state: "preparing" | "failed" | "waiting" | "proposed"; error?: string } {
    const q = this.queues.get(paperId);
    const key = `unit:${unit}`;
    if (q?.current && taskKey(q.current) === key) return { state: "preparing" };
    if (q?.tasks.some((t) => taskKey(t) === key)) return { state: "preparing" };
    const failed = q?.failed.get(key);
    if (failed) return { state: "failed", error: failed.why };
    if (q?.proposed.has(key)) return { state: "proposed" };
    return { state: "waiting" };
  }

  private settings(): ReaderAgentSettings {
    try {
      return this.host()?.settings?.() ?? AUTO;
    } catch {
      return { ...AUTO, mode: "ask" };
    }
  }

  /** The most agent turns a task may take (what the reader is told before pressing Soạn). */
  private maxTurns(task: Task, s: ReaderAgentSettings): number {
    // A checkpoint: the author's turns, then per check up to two checker turns, and one author turn per fix round.
    return task.kind === "unit" && s.checker ? TURNS + 2 * (s.rounds + 1) + s.rounds : TURNS;
  }

  /** Already written: nothing to do. */
  private done(paperId: string, task: Task): boolean {
    if (task.kind === "unit") return !!this.passes.pack(paperId, task.unit);
    if (task.kind === "widget") return !!this.hub.widgets.read(paperId, task.request.id);
    if (task.kind === "deep") return !!this.hub.deep.read(paperId);
    if (task.kind === "cards") return this.hub.cards.hasProposals(paperId);
    return !this.passes.mapMissing(paperId).length;
  }

  private stopped(paperId: string): boolean {
    try {
      return this.hub.store.readJson<{ stopped?: boolean }>(paperId, "author.json")?.stopped === true;
    } catch {
      return false;
    }
  }

  private setStopped(paperId: string, stopped: boolean): void {
    this.hub.store.writeJsonFile(paperId, "author.json", { stopped });
  }

  private queue(paperId: string): Queue {
    let q = this.queues.get(paperId);
    if (!q) {
      q = { tasks: [], state: "idle", failed: new Map(), proposed: new Map() };
      this.queues.set(paperId, q);
    }
    return q;
  }

  private taskLabel(paperId: string, t: Task): string {
    if (t.kind === "map") return "Bản đồ paper";
    if (t.kind === "widget") return `Ví dụ · ${t.request.goal}`;
    if (t.kind === "deep") return "Bài tập đào sâu";
    if (t.kind === "cards") return "Thẻ ôn";
    const u = this.passes.units(paperId).find((x) => x.id === t.unit);
    return `Checkpoint ${u?.number ? `§${u.number}` : u?.title ?? t.unit}`;
  }

  private async run(paperId: string): Promise<void> {
    const q = this.queue(paperId);
    const host = this.host();
    if (!host || q.current) return;
    const abort = new AbortController();
    q.abort = abort;
    q.state = "running";
    let chat: AuthorChat | null = null;
    try {
      while (q.tasks.length && !abort.signal.aborted) {
        const task = q.tasks.shift()!;
        q.current = task;
        q.note = undefined;
        this.hub.touch(paperId);
        try {
          chat ??= host.chat(paperId, new ReaderAuthorRole(this.hub, paperId, this), "author");
          if (task.kind === "map") await this.doMap(paperId, chat, abort.signal);
          else if (task.kind === "unit") await this.doUnit(paperId, task.unit, chat, abort.signal, host);
          else if (task.kind === "widget") await this.doWidget(paperId, task.request, chat, abort.signal);
          else if (task.kind === "deep") await this.prepare(chat, abort.signal, () => !!this.hub.deep.read(paperId),
            "Soạn bài đào sâu.", "Read the paper first. Use reader_deep_write for 5–8 distinct analyze/evaluate/create questions, analytic rubrics and sample answers. Include a derivation when there is an equation and a flawed passage with 2–3 planted errors, each with an exact evidence quote that disproves it. Include a question on assumptions and experimental or analytical limitations. Write in Vietnamese.");
          else await this.prepare(chat, abort.signal, () => this.hub.cards.hasProposals(paperId),
            "Đề xuất thẻ ôn.", "Read the paper. Use reader_card_propose with 5–20 short in-scope cards in Vietnamese. Ask one specific open question per card; give a short unambiguous answer. Cover important ideas from several angles and attribute claims to the paper by name. Attach exact evidence from the paper to each card.");
        } catch (e) {
          if (!abort.signal.aborted) q.failed.set(taskKey(task), { task, why: (e as Error).message.slice(0, 300) });
          host.log?.(`Reader: ${paperId} ${taskKey(task)}: ${(e as Error).message}`);
        }
        q.current = undefined;
        q.note = undefined;
      }
    } finally {
      chat?.close();
      q.current = undefined;
      q.note = undefined;
      q.abort = undefined;
      q.state = abort.signal.aborted ? "stopped" : q.failed.size ? "failed" : "idle";
      this.hub.touch(paperId);
    }
    // Soạn pressed while a stopped task was still winding down: what it queued runs now.
    if (q.tasks.length) void this.run(paperId);
  }

  private async prepare(chat: AuthorChat, signal: AbortSignal, ready: () => boolean, label: string, context: string): Promise<void> {
    for (let turn = 0; turn < TURNS && !signal.aborted && !ready(); turn++) {
      chat.send(label, context);
      await chat.whenIdle(signal);
    }
    if (!signal.aborted && !ready()) throw new Error("nội dung chưa qua kiểm tra");
  }

  saveDeep(paperId: string, input: z.infer<typeof DeepSchema>): void {
    const q = this.queues.get(paperId);
    if (q?.current?.kind !== "deep" || q.abort?.signal.aborted) throw new Error("No active deep task.");
    this.hub.deep.save(paperId, input);
  }

  saveCards(paperId: string, cards: z.infer<typeof CardBatchSchema>): void {
    const q = this.queues.get(paperId);
    if (q?.current?.kind !== "cards" || q.abort?.signal.aborted) throw new Error("No active card task.");
    this.hub.cards.propose(paperId, cards);
  }

  private async doWidget(paperId: string, request: ReaderWidgetRequest, chat: AuthorChat, signal: AbortSignal): Promise<void> {
    const context = `Make one interactive numeric example for ${JSON.stringify(request)}. Read the cited part. Use reader_widget_write. Each output expression is a JSON string encoding a numeric operand, a parameter name, or an array ["operator", arg, arg] with + - * / pow min max; sqrt exp log abs take one argument. For example, expression: '[ "*", "r", 8 ]'. Use a tiny worked example, state which numbers are illustrative, ask for a prediction before showing results, and give concrete comparisons to try. For a curve or points set series.axis to a parameter. Set steps to show one output at a time, or set matrix dimensions for row-major outputs. Each control is a slider by default; options or toggle can be used for discrete controls. Supply independently calculated expectations for at least two input configurations from the cited formula. Output Vietnamese.`;
    for (let turn = 0; turn < TURNS && !signal.aborted && !this.hub.widgets.read(paperId, request.id); turn++) {
      chat.send(turn ? "Sửa ví dụ theo kết quả tự kiểm." : "Soạn ví dụ tương tác.", context);
      await chat.whenIdle(signal);
    }
    if (!signal.aborted && !this.hub.widgets.read(paperId, request.id)) throw new Error("ví dụ chưa qua tự kiểm");
  }

  writeWidget(paperId: string, input: z.infer<typeof WidgetSchema>): void {
    const queue = this.queues.get(paperId);
    if (queue?.current?.kind !== "widget" || queue.abort?.signal.aborted) throw new Error("No active widget task.");
    this.hub.widgets.save(paperId, queue.current.request, input);
  }

  private async doMap(paperId: string, chat: AuthorChat, signal: AbortSignal): Promise<void> {
    for (let turn = 1; turn <= TURNS && !signal.aborted; turn++) {
      const missing = this.passes.mapMissing(paperId);
      if (!missing.length) return;
      chat.send(turn === 1 ? "Soạn bản đồ paper." : `Bản đồ còn thiếu: ${missing.join(", ")}.`, mapTask(this.hub, paperId, missing));
      await chat.whenIdle(signal);
    }
    const missing = this.passes.mapMissing(paperId);
    if (missing.length && !signal.aborted) throw new Error(`chưa viết xong bản đồ (còn thiếu ${missing.join(", ")})`);
  }

  private async doUnit(paperId: string, unitId: string, chat: AuthorChat, signal: AbortSignal, host: ReaderAuthorHost): Promise<void> {
    const unit = this.passes.units(paperId).find((u) => u.id === unitId);
    if (!unit) throw new Error("không còn mục này");
    if (this.passes.pack(paperId, unitId)) return;
    const key = draftKey(paperId, unitId);
    this.drafts.delete(key);
    try {
      for (let turn = 1; turn <= TURNS && !this.drafts.has(key) && !signal.aborted; turn++) {
        chat.send(`Soạn checkpoint ${unitLabel(unit)}.`, unitTask(this.hub, this.passes, paperId, unit, turn));
        await chat.whenIdle(signal);
      }
      if (signal.aborted) return;
      if (!this.drafts.has(key)) throw new Error("người soạn chưa viết được checkpoint của mục này");
      const q = this.queue(paperId);
      const unchecked = new Set<string>();
      const settings = this.settings();
      if (!settings.checker) {
        // The reader turned the checker off: the questions arrive marked as not checked.
        for (const i of this.drafts.get(key)!.items) unchecked.add(i.id);
      }
      for (let round = 0; settings.checker && !signal.aborted; round++) {
        const draft = this.drafts.get(key)!;
        const batch = draft.items.filter((i) => draft.changed.has(i.id));
        if (!batch.length) break;
        q.note = round ? `người kiểm giải lại ${batch.length} câu` : `người kiểm giải mù ${batch.length} câu`;
        this.hub.touch(paperId);
        const verdicts = await this.check(paperId, batch, signal, host);
        draft.changed.clear();
        if (!verdicts) {
          // The checker could not run: the questions reach the reader marked as not checked.
          for (const i of batch) unchecked.add(i.id);
          break;
        }
        const bad: { item: ReaderItem; said: string }[] = [];
        for (const item of batch) {
          const v = verdicts.get(item.id)!;
          if (v.bloom !== item.bloom) {
            item.authorBloom = item.bloom;
            item.bloom = v.bloom;
          }
          if (!v.ok) bad.push({ item, said: v.said });
        }
        const lowOnly = !draft.pack.light && draft.items.length > 0 && !draft.items.some((i) => atLeastApply(i.bloom));
        this.hub.store.append(paperId, { t: "r.quality", at: Date.now(), counts: {
          blindSeen: batch.length, blindPassed: batch.length - bad.length, bloomChanged: batch.filter((i) => i.authorBloom !== undefined).length,
          ...(lowOnly ? { bloomRejected: 1 } : {}),
        } });
        if (!bad.length && !lowOnly) break;
        if (round >= settings.rounds) {
          // Still not solved blind after the last fix round: the question does not reach the reader.
          const drop = new Set(bad.map((b) => b.item.id));
          draft.items = draft.items.filter((i) => !drop.has(i.id));
          break;
        }
        q.note = `sửa ${bad.length} câu người kiểm trả lại`;
        this.hub.touch(paperId);
        chat.send(`Người kiểm trả lại ${bad.length} câu của ${unitLabel(unit)}.`, fixTask(unit, bad, lowOnly));
        await chat.whenIdle(signal);
        // Not fixed nor dropped: it goes.
        const after = this.drafts.get(key)!;
        const stale = new Set(bad.map((b) => b.item.id).filter((id) => !after.changed.has(id)));
        after.items = after.items.filter((i) => !stale.has(i.id) || after.changed.has(i.id));
      }
      if (signal.aborted) return;
      const draft = this.drafts.get(key)!;
      const pack: ReaderPack = {
        ...draft.pack,
        items: draft.items.map((i) => (unchecked.has(i.id) ? { ...i, unchecked: true as const } : i)),
        checked: !unchecked.size,
        at: Date.now(),
      };
      this.passes.savePack(paperId, pack);
    } finally {
      this.drafts.delete(key);
    }
  }

  /** A batch solved blind by a fresh checker; null when the checker could not answer at all. */
  private async check(paperId: string, batch: ReaderItem[], signal: AbortSignal, host: ReaderAuthorHost): Promise<Map<string, ReturnType<typeof verdictOf>> | null> {
    const role = new ReaderCheckerRole(this.hub, paperId, batch);
    const chat = host.chat(paperId, role, "checker");
    try {
      chat.send("Giải mù các câu hỏi này.", checkerTask(this.hub, paperId, batch));
      await chat.whenIdle(signal);
      if (!role.answers.size && !signal.aborted) {
        chat.send("Write your answers with reader_check_write.", "");
        await chat.whenIdle(signal);
      }
    } finally {
      chat.close();
    }
    if (!role.answers.size) return null;
    return new Map(batch.map((i) => [i.id, verdictOf(i, role.answers.get(i.id))]));
  }

  // ------------------------------------------------------------------ what the author's tools do

  writeMap(paperId: string, input: MapInput): string {
    const doc = this.hub.doc(paperId);
    const map: ReaderMap = { ...this.passes.map(paperId) };
    const saved: string[] = [];
    const refused: string[] = [];
    for (const part of Object.keys(input) as (keyof MapInput)[]) {
      if (input[part] === undefined) continue;
      if (part === "units" && !pagedDoc(doc)) {
        refused.push("units: this paper has its own sections; its units are its top sections (no need to write them).");
        continue;
      }
      const issues = lintMapPart(part, input, doc);
      if (issues.length) {
        refused.push(...issues);
        continue;
      }
      if (part === "pretest") map.pretest = input.pretest!.map((p) => ({ ...p, id: pretestId(p) }));
      else if (part === "units") map.units = input.units!.map((u) => ({ id: u.sections[0]!, title: u.title, sections: u.sections }));
      else (map as unknown as Record<string, unknown>)[part] = input[part];
      saved.push(part);
    }
    if (saved.length) this.passes.saveMap(paperId, map);
    const missing = this.passes.mapMissing(paperId);
    return [
      saved.length ? `Saved: ${saved.join(", ")} (the reader sees them now).` : "Nothing saved.",
      refused.length ? `Refused (fix and write these parts again):\n${refused.map((r) => `- ${r}`).join("\n")}` : "",
      missing.length ? `Still missing: ${missing.join(", ")}.` : "The map is complete.",
    ].filter(Boolean).join("\n");
  }

  writePack(paperId: string, input: PackInput): { text: string; isError?: boolean } {
    const unit = this.passes.units(paperId).find((u) => u.id === input.unit);
    if (!unit) return { text: `No unit "${input.unit}". The units: ${this.passes.units(paperId).map((u) => u.id).join(", ")}.`, isError: true };
    const key = draftKey(paperId, unit.id);
    const issues = lintPack(input, { doc: this.hub.doc(paperId), unit, concepts: this.concepts(paperId), others: this.otherItems(paperId, unit.id) });
    this.hub.store.append(paperId, { t: "r.quality", at: Date.now(), counts: measureRules(issues, input.items.length) });
    if (issues.length) return { text: `Not saved. Fix these and write the whole checkpoint again:\n${issues.map((i) => `- ${i}`).join("\n")}`, isError: true };
    const items = input.items.map((i) => ({ ...i, id: itemId(unit.id, i), unit: unit.id }));
    this.drafts.set(key, { pack: input, items, changed: new Set(items.map((i) => i.id)) });
    return { text: `Saved ${items.length} question(s) of ${unit.id}: ${items.map((i) => i.id).join(", ")}. The checker now solves them blind; questions it answers otherwise come back to you. Stop here for now.` };
  }

  fixItems(paperId: string, input: { unit: string; fixes: { id: string; item?: ItemInput; drop?: boolean }[]; add?: ItemInput[] }): { text: string; isError?: boolean } {
    const key = draftKey(paperId, input.unit);
    const draft = this.drafts.get(key);
    if (!draft) return { text: `There is no checkpoint of "${input.unit}" being checked now.`, isError: true };
    const doc = this.hub.doc(paperId);
    const concepts = this.concepts(paperId);
    const issues: string[] = [];
    const next = [...draft.items];
    const fresh: ReaderItem[] = [];
    const take = (item: ItemInput, label: string) => {
      const found = lintItem(item, doc, concepts);
      const dup = next.concat(fresh).find((o) => nearDuplicate(o.stem, item.stem) && o.stem !== item.stem);
      if (dup) found.push(`says nearly the same as ${dup.id}.`);
      if (found.length) {
        issues.push(...found.map((f) => `${label}: ${f}`));
        return;
      }
      fresh.push({ ...item, id: itemId(input.unit, item), unit: input.unit });
    };
    for (const f of input.fixes) {
      const at = next.findIndex((i) => i.id === f.id);
      if (at < 0) {
        issues.push(`${f.id}: no such question in ${input.unit}.`);
        continue;
      }
      if (f.drop) {
        next.splice(at, 1);
        continue;
      }
      if (!f.item) {
        issues.push(`${f.id}: give the corrected item, or drop: true.`);
        continue;
      }
      const before = fresh.length;
      take(f.item, f.id);
      if (fresh.length > before) next.splice(at, 1);
    }
    for (const [n, item] of (input.add ?? []).entries()) take(item, `new ${n + 1}`);
    draft.items = [...next, ...fresh];
    for (const i of fresh) draft.changed.add(i.id);
    if (draft.items.length > 8) draft.items = draft.items.slice(0, 8);
    return {
      text: `${fresh.length ? `Saved ${fresh.length} question(s): ${fresh.map((i) => i.id).join(", ")} (the checker solves them next).` : "No question saved."}${issues.length ? `\nRefused:\n${issues.map((i) => `- ${i}`).join("\n")}` : ""}`,
      ...(issues.length && !fresh.length ? { isError: true } : {}),
    };
  }

  private concepts(paperId: string): Set<string> | undefined {
    const c = this.passes.map(paperId).concepts;
    return c?.length ? new Set(c.map((x) => x.id)) : undefined;
  }

  private otherItems(paperId: string, unit: string): ReaderItem[] {
    return this.passes.items(paperId).filter((i) => i.unit !== unit);
  }
}

function draftKey(paperId: string, unit: string): string {
  return `${paperId}\u0000${unit}`;
}

function unitLabel(u: Pick<ReaderUnitDef, "number" | "title">): string {
  return u.number ? `§${u.number} ${u.title}` : u.title;
}

// ------------------------------------------------------------------ the author's role and tools

/** What the author's tools reach. */
export interface AuthorToolHost extends ReaderToolHost {
  readonly author: ReaderAuthor;
}

const mapWrite = tool({
  name: "reader_map_write",
  description: "Write parts of the paper's map (any of: roles, fivec, concepts, notation, background, pretest, and units for a PDF). Each part is checked on its own: accepted parts are saved and shown to the reader at once; refused ones come back with what to fix.",
  schema: MapSchema,
  async run(ctx: ReaderToolContext & { reader: AuthorToolHost }, args): Promise<ToolResult> {
    return { text: ctx.reader.author.writeMap(ctx.reader.paperId, args) };
  },
});

const itemsWrite = tool({
  name: "reader_items_write",
  description: "Write a unit's checkpoint: the question to read it for, its key points, a place to explain, figures, tables to guess, a QALMRI sheet for an experiment, and 3–6 questions. Checked against the rules (refused with reasons), then the questions are solved blind by a checker.",
  schema: PackSchema,
  async run(ctx: ReaderToolContext & { reader: AuthorToolHost }, args): Promise<ToolResult> {
    return ctx.reader.author.writePack(ctx.reader.paperId, args);
  },
});

const itemsFix = tool({
  name: "reader_items_fix",
  description: "Fix questions the checker gave back: replace one (its id and the corrected item), drop one, or add new ones.",
  schema: z.object({
    unit: z.string().min(1).max(120),
    fixes: z.array(z.object({ id: z.string().min(1).max(40), item: ItemSchema.optional(), drop: z.boolean().optional() })).max(8).default([]),
    add: z.array(ItemSchema).max(4).optional(),
  }),
  async run(ctx: ReaderToolContext & { reader: AuthorToolHost }, args): Promise<ToolResult> {
    return ctx.reader.author.fixItems(ctx.reader.paperId, args);
  },
});

const widgetWrite = tool({
  name: "reader_widget_write",
  description: "Save the interactive example for the active request. The bridge validates every evidence quote, expression, and test before saving.",
  schema: WidgetToolSchema,
  async run(ctx: ReaderToolContext & { reader: AuthorToolHost }, args): Promise<ToolResult> {
    ctx.reader.author.writeWidget(ctx.reader.paperId, decodeWidgetTool(args));
    return { text: "Saved: the widget passed its checks." };
  },
});

const deepWrite = tool({
  name: "reader_deep_write",
  description: "Write the deep-reading exercise pack. All quotes are checked before it is saved.",
  schema: DeepSchema,
  async run(ctx: ReaderToolContext & { reader: AuthorToolHost }, args): Promise<ToolResult> {
    ctx.reader.author.saveDeep(ctx.reader.paperId, args);
    return { text: "Saved the deep-reading exercises." };
  },
});

const cardsWrite = tool({
  name: "reader_card_propose",
  description: "Propose a batch of 5–20 review cards with verifiable paper evidence. The reader decides which to keep.",
  schema: z.object({ cards: CardBatchSchema }),
  async run(ctx: ReaderToolContext & { reader: AuthorToolHost }, args): Promise<ToolResult> {
    ctx.reader.author.saveCards(ctx.reader.paperId, args.cards);
    return { text: "Saved the card proposals." };
  },
});

const AUTHOR_TOOLS: readonly ToolDef<any, any>[] = [...READER_TOOLS, mapWrite, itemsWrite, itemsFix, widgetWrite, deepWrite, cardsWrite];

export class ReaderAuthorRole implements ChatRole, AuthorToolHost {
  readonly settings = READER_SETTINGS;

  constructor(readonly hub: ReaderHub, readonly paperId: string, readonly author: ReaderAuthor) {}

  attach(_port: ChatPort): () => void {
    return () => {};
  }

  snapshot() {
    return {};
  }

  async prompt(turn: RoleTurn): Promise<string> {
    return [turn.rules ? authorPlaybook(this.hub, this.paperId) : "", turn.recap, turn.context ?? "", turn.text].filter(Boolean).join("\n\n");
  }

  tools(): readonly ToolDef<any, any>[] {
    return AUTHOR_TOOLS;
  }

  runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolResult> {
    return callTool(Object.assign(ctx, { reader: this as AuthorToolHost }), name, args, AUTHOR_TOOLS);
  }
}

function authorPlaybook(hub: ReaderHub, paperId: string): string {
  const meta = hub.meta(paperId);
  return `<reader-author>
You prepare the paper "${meta.title}"${meta.authors ? ` (${meta.authors}${meta.year ? `, ${meta.year}` : ""})` : ""} for one reader who wants to understand it in depth. You work in the background: the reader never sees this chat, only what your tools save, and a separate tutor chats with them.

- Language: Vietnamese for everything the reader reads (questions, options, explanations, meanings), keeping technical terms in English; quotes are the paper's exact English words.
- Read before you write: paper_read (a section by id; with no section, the outline and then the paper), paper_find, paper_figure${meta.view === "pdf" ? ", paper_page" : ""}. Use only ids from your tool results.
- Evidence quotes are copied exactly from paper_read (formulas as their TeX); the bridge refuses a quote that is not in the paper.
- Your tools check what you write and say what is wrong: fix it and write again. Do only the task you are given, then stop.
</reader-author>`;
}

/** The map's task: the parts still missing. */
function mapTask(hub: ReaderHub, paperId: string, missing: string[]): string {
  const doc = hub.doc(paperId);
  const parts: Record<string, string> = {
    roles: "roles — the 8–30 paragraphs a skimming reader should not miss, each with its role: objective (the problem and goal), contribution, method, result, limitation.",
    fivec: "fivec — the reference five Cs, 1–3 sentences each with [[anchors]]: category (what kind of paper), context (what it builds on), correctness (are its assumptions sound), contributions, clarity.",
    concepts: "concepts — 5–12 key concepts (kebab-case id, name, the anchor where the paper introduces it). The checkpoints' questions will each check one.",
    notation: "notation — the symbols and key terms in the order they appear: TeX symbol, a short Vietnamese meaning, the shape for a tensor, the anchor of its definition.",
    background: "background — 0–6 things to know before (\"rank of a matrix\", \"fine-tuning vs adapters\"): why this paper needs it, a short explanation, and a link to an easier source than the paper when you know a good one. An empty list when the paper needs none.",
    pretest: "pretest — 3 questions asked before reading, on the ideas the paper is about to make (\"Fine-tuning all of GPT-3 costs where?\"); `section` is where the answer is. One has 3 options whose wrong ones are other ideas from the paper itself; the others have no options (the reader writes a guess). Each has its answer, an explanation and evidence.",
    units: "units — the paper's sections as groups of its pages (\"page-3\", …), in order, with the section titles as the paper has them: the reader reads and checks them one by one.",
  };
  return [
    "<reader-task kind=\"map\">",
    `Write the paper's map with reader_map_write, part by part (one call can carry several parts). Still needed: ${missing.join(", ")}.`,
    ...missing.map((m) => `- ${parts[m] ?? m}`),
    pagedDoc(doc) ? "This paper is a PDF: its sections are its pages (page-1, page-2, …)." : "",
    "Start by reading the paper (paper_read with no section gives the outline first, then the text).",
    "</reader-task>",
  ].filter(Boolean).join("\n");
}

const EXAMPLE = `{"concept":"low-rank-update","bloom":"apply","kind":"twotier",
 "stem":"Một lớp có $W_0 \\\\in \\\\mathbb{R}^{1024\\\\times 1024}$ được fine-tune bằng LoRA với $r=8$. Ngay khi bắt đầu fine-tune, đầu ra $h$ của lớp so với mô hình gốc thế nào?",
 "options":[{"text":"Giống hệt đầu ra của mô hình gốc","correct":true,"why":"B = 0 nên ΔW = BA = 0"},
  {"text":"Lệch một chút vì nhiễu Gaussian của A","correct":false,"why":"Nghĩ A ngẫu nhiên thì BA cũng ngẫu nhiên, quên rằng B = 0"},
  {"text":"Bằng 0 vì ΔW chưa học được gì","correct":false,"why":"Nhầm h = ΔWx, quên rằng W₀x vẫn còn"}],
 "reasons":[{"text":"B khởi tạo bằng 0 nên tích BA bằng 0","correct":true,"why":"Đúng như paper viết"},
  {"text":"A khởi tạo bằng 0 nên tích BA bằng 0","correct":false,"why":"Nhầm vai trò của A và B"},
  {"text":"Hệ số α/r làm ΔW nhỏ không đáng kể","correct":false,"why":"Nhầm việc scale với việc khởi tạo"}],
 "evidence":[{"anchor":"S4.SS1.p2","quote":"We use a random Gaussian initialization for $A$ and zero for $B$, so $\\\\Delta W=BA$ is zero at the beginning of training."}],
 "explain":"B = 0 lúc đầu nên ΔW = BA = 0 và h = W₀x: fine-tune bắt đầu đúng từ mô hình gốc [[S4.SS1.p2]].","difficulty":2}`;

/** A unit's checkpoint task. */
function unitTask(hub: ReaderHub, passes: ReaderPasses, paperId: string, unit: ReaderUnitDef, turn: number): string {
  const map = passes.map(paperId);
  const doc = hub.doc(paperId);
  const figures = doc.blocks.filter((b) => unit.sections.includes(b.section) && (b.kind === "fig" || b.kind === "table")).map((b) => `${b.id} (${(b.caption ?? b.text).slice(0, 70)})`);
  const others = passes.items(paperId).filter((i) => i.unit !== unit.id).slice(-20).map((i) => `- [${i.concept}/${i.bloom}] ${i.stem.slice(0, 120)}`);
  return [
    `<reader-task kind="checkpoint" unit="${unit.id}">`,
    `Write the checkpoint of ${unitLabel(unit)} (sections ${unit.sections.join(", ")}) with one reader_items_write call (unit: "${unit.id}"). Read the unit first: paper_read section "${unit.id}".${turn > 1 ? " It is not saved yet: write it now." : ""}`,
    map.concepts?.length ? `Concepts (use their ids): ${map.concepts.map((c) => `${c.id} (${c.name})`).join(", ")}.` : "The map has no concepts yet: name each question's concept with a short kebab-case id.",
    figures.length ? `Its figures and tables: ${figures.join("; ")}.` : "",
    others.length ? `Questions of other units (do not repeat them):\n${others.join("\n")}` : "",
    "What to write:",
    "- guide: one question to read the unit for, about its key idea.",
    "- points: its 2–6 key points, each with the anchor that supports it (the reader's recall is graded against them).",
    "- explain: one key line or step (an equation or a paragraph of this unit) to explain in their own words — prompt, a rubric of what a real explanation says (the why, not a restatement), common misconceptions.",
    "- figures: its main figures and tables, each with the main message in one sentence (and up to 3 questions of its own). predicts: up to 3 results tables whose numbers are hidden for a guess first — what to guess, and the answer.",
    "- qalmri: when the unit reports an experiment, the reference sheet (question, alternatives, logic, method, result, inference).",
    "- light: only for a unit with nothing to check (related work, conclusion): why; then 0–2 questions.",
    "- items: 3–6 questions on what the unit teaches. Think step by step about what a reader must understand here, then write each question at a level of Bloom's scale: remember (recall a fact), understand (explain, compare), apply (use the idea on a new small case: compute, predict), analyze (why this part, what if it were removed), evaluate (judge a choice with evidence), create (design a variant). At least one at apply or higher; mostly understand and above.",
    "  Kinds: mcq (3 options), twotier (an answer and why: for a key why), multi, numeric (a number with a tolerance), order (steps), match (symbol ↔ meaning).",
    "  Rules: one right option; plausible wrong options, each with the misconception it stands for (why); options alike in kind and length; no \"all/none of the above\"; a positive stem holding the main idea; evidence quotes copied from paper_read; explain cites [[anchors]].",
    "One good question (its format, not its topic):",
    EXAMPLE,
    "</reader-task>",
  ].filter(Boolean).join("\n");
}

/** The checker's disagreements, back to the author. */
function fixTask(unit: ReaderUnitDef, bad: { item: ReaderItem; said: string }[], lowOnly: boolean): string {
  return [
    `<reader-task kind="fix" unit="${unit.id}">`,
    bad.length ? "A checker solved these questions blind from their evidence and did not reach your answer. For each, fix it with reader_items_fix (its id and the corrected item) so that its evidence decides the answer and only one option can be defended — or drop it." : "",
    ...bad.map((b) => `- ${b.item.id} “${b.item.stem.slice(0, 160)}”: ${b.said}`),
    lowOnly ? "After the checker's levels, no question is at apply level or higher: add one with reader_items_fix (add)." : "",
    "</reader-task>",
  ].filter(Boolean).join("\n");
}
