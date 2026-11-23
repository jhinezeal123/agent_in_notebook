import { createHash } from "node:crypto";
import { readerCompute, type ReaderAnchor, type ReaderWidgetRequest, type ReaderWidgetView } from "@ainb/protocol";
import { z } from "zod";
import type { ReaderHub } from "./index.js";
import { EvidenceSchema } from "./items.js";
import { lintEvidence } from "./lint.js";

const arity: Readonly<Record<string, number>> = { "+": 2, "-": 2, "*": 2, "/": 2, pow: 2, sqrt: 1, exp: 1, log: 1, abs: 1, min: 2, max: 2 };
const number = z.number().finite();
const label = z.string().trim().min(1).max(200);
// checkWidget validates the tree's grammar and depth.
const expression = z.union([z.number(), z.string(), z.tuple([z.string()]).rest(z.unknown())]);
export const WidgetSchema = z.object({
  title: label, explanation: z.string().trim().min(1).max(1600),
  evidence: z.array(EvidenceSchema).min(1).max(4),
  tryThis: z.array(label).min(1).max(4),
  prediction: z.object({ question: label, choices: z.array(label).min(2).max(5), right: z.number().int().nonnegative() }).optional(),
  model: z.object({
    params: z.array(z.object({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/), label, min: number, max: number, step: number.positive(), init: number,
      options: z.array(z.object({ label, value: number })).min(2).max(8).optional(), toggle: z.boolean().optional(),
    })).min(1).max(8),
    outputs: z.array(z.object({ label, expression })).min(1).max(16),
    series: z.object({ axis: label, min: number, max: number, count: z.number().int().min(2).max(80), style: z.enum(["line", "points"]).optional() }).optional(),
    matrix: z.object({ rows: z.number().int().min(2).max(8), columns: z.number().int().min(2).max(8), heatmap: z.boolean().optional() }).optional(),
    steps: z.boolean().optional(),
  }),
  tests: z.array(z.object({ name: label, inputs: z.record(z.string(), number), output: z.number().int().nonnegative(), expected: number, tolerance: number.nonnegative().max(0.01).default(1e-8) })).min(2).max(20),
});

type Widget = z.infer<typeof WidgetSchema> & ReaderWidgetRequest;

export function checkWidget(w: z.infer<typeof WidgetSchema>): void {
  const { params, outputs, series } = w.model;
  const names = new Set(params.map((p) => p.name));
  if (names.size !== params.length || params.some((p) => p.max <= p.min || p.init < p.min || p.init > p.max || p.step > p.max - p.min)) throw new Error("Invalid parameter range or duplicate name.");
  for (const p of params) {
    if (p.toggle && (p.options || p.init !== p.min && p.init !== p.max)) throw new Error(`Toggle ${p.name} uses its min/max values.`);
    if (p.options && (new Set(p.options.map((o) => o.value)).size !== p.options.length || !p.options.some((o) => o.value === p.init) || p.options.some((o) => o.value < p.min || o.value > p.max))) throw new Error(`Invalid choices for ${p.name}.`);
  }
  if (series && (!names.has(series.axis) || series.max <= series.min || !params.some((p) => p.name === series.axis && series.min >= p.min && series.max <= p.max))) throw new Error("Series axis must be a parameter and stay within its range.");
  if (w.model.matrix && (w.model.matrix.rows * w.model.matrix.columns !== outputs.length || w.model.steps)) throw new Error("Provide one output per matrix entry, in row-major order.");
  if (w.model.steps && outputs.length < 2) throw new Error("A stepped example requires multiple outputs.");
  if (w.prediction && (w.prediction.right >= w.prediction.choices.length || new Set(w.prediction.choices).size !== w.prediction.choices.length)) throw new Error("Invalid prediction answer.");
  let nodes = 0;
  function check(e: unknown, depth: number): boolean {
    if (depth > 16 || ++nodes > 1000) return false;
    if (typeof e === "number") return Number.isFinite(e);
    if (typeof e === "string") return names.has(e);
    return Array.isArray(e) && typeof e[0] === "string" && Object.hasOwn(arity, e[0])
      && e.length === arity[e[0]]! + 1 && e.slice(1).every((arg) => check(arg, depth + 1));
  }
  if (!outputs.every((o) => check(o.expression, 0))) throw new Error("Use bounded expressions with numbers, parameter names and supported operators.");
  const initial = Object.fromEntries(params.map((p) => [p.name, p.init]));
  if (!outputs.every((o) => Number.isFinite(readerCompute(o.expression, initial)))) throw new Error("The initial configuration must have finite outputs.");
  for (const t of w.tests) {
    const output = outputs[t.output];
    if (!output || Object.keys(t.inputs).length === 0 || Object.entries(t.inputs).some(([name, value]) => !params.some((p) => p.name === name && value >= p.min && value <= p.max))) throw new Error(`Invalid test input: ${t.name}.`);
    const result = readerCompute(output.expression, { ...initial, ...t.inputs });
    if (!Number.isFinite(result) || Math.abs(result - t.expected) > t.tolerance) throw new Error(`${t.name}: expected ${t.expected}, got ${result}.`);
  }
  if (new Set(w.tests.map((t) => JSON.stringify({ ...initial, ...t.inputs }))).size < 2) throw new Error("Use at least two distinct input configurations.");
}

export class ReaderWidgets {
  constructor(private readonly hub: ReaderHub) {}

  requests(paperId: string): ReaderWidgetRequest[] {
    return this.hub.store.readJson<ReaderWidgetRequest[]>(paperId, "widgets/requests.json") ?? [];
  }

  request(paperId: string, anchor: ReaderAnchor, rawGoal: string, offered = false): ReaderWidgetRequest {
    const goal = label.parse(rawGoal);
    const doc = this.hub.doc(paperId);
    if (!anchor || (!anchor.id && !anchor.page)) throw new Error("Chọn một đoạn hoặc công thức trong paper.");
    const id = anchor.id ?? `page-${anchor.page}`;
    if (!doc.sections.some((s) => s.id === id) && !doc.blocks.some((b) => b.id === id) && !doc.equations.some((e) => e.id === id)) throw new Error("Không thấy mốc trong paper.");
    const request = { id: createHash("sha256").update(JSON.stringify([id, goal])).digest("hex").slice(0, 16), anchor: { id, ...(anchor.quote ? { quote: String(anchor.quote).slice(0, 400) } : {}) }, goal, ...(offered ? { offered: true } : {}) };
    const all = this.requests(paperId);
    const previous = all.find((r) => r.id === request.id);
    if (!previous) {
      if (all.length >= 40) throw new Error("Paper này đã có 40 yêu cầu ví dụ.");
      this.hub.store.writeJsonFile(paperId, "widgets/requests.json", [...all, request]);
    } else if (previous.offered && !offered) {
      this.hub.store.writeJsonFile(paperId, "widgets/requests.json", all.map((r) => r.id === request.id ? request : r));
    }
    if (!offered) this.hub.author.enqueue(paperId, { kind: "widget", request });
    this.hub.touch(paperId);
    return request;
  }

  read(paperId: string, id: string): Widget | null {
    return /^[a-f0-9]{16}$/.test(id) ? this.hub.store.readJson<Widget>(paperId, `widgets/${id}/spec.json`) : null;
  }

  save(paperId: string, request: ReaderWidgetRequest, widget: z.infer<typeof WidgetSchema>): void {
    const at = Date.now();
    try {
      const errors = lintEvidence(widget.evidence, this.hub.doc(paperId));
      if (errors.length) throw new Error(errors.join("\n"));
      checkWidget(widget);
      this.hub.store.writeJsonFile(paperId, `widgets/${request.id}/spec.json`, { ...request, ...widget });
    } catch (error) {
      this.hub.store.append(paperId, { t: "r.quality", at, counts: { widgetsChecked: 1 } });
      throw error;
    }
    this.hub.store.append(paperId, { t: "r.quality", at, counts: { widgetsChecked: 1, widgetsPassed: 1 } });
    this.hub.touch(paperId);
  }

  views(paperId: string): ReaderWidgetView[] {
    const state = this.hub.store.state(paperId);
    return this.requests(paperId).flatMap((r) => {
      const w = this.read(paperId, r.id);
      if (!w || state.reports.has(`widget:${r.id}`)) return [];
      const answer = state.widgetAnswers.get(w.id);
      const skipped = state.skipped.has(`widget:${w.id}`);
      const unlocked = !w.prediction || !!answer || skipped;
      return [{ ...r, title: w.title, tryThis: unlocked ? w.tryThis : [], evidence: w.evidence,
        ...(w.prediction ? { prediction: { question: w.prediction.question, choices: w.prediction.choices } } : {}),
        ...(unlocked ? { model: w.model, explanation: w.explanation } : {}),
        ...(answer && w.prediction ? { result: { ...answer, right: w.prediction.right } } : {}),
        ...(skipped && w.prediction ? { skipped: true, right: w.prediction.right } : {}) }];
    });
  }

  answer(paperId: string, id: string, choice: number): void {
    const w = this.read(paperId, id);
    const state = this.hub.store.state(paperId);
    if (!w?.prediction || state.reports.has(`widget:${id}`) || !Number.isInteger(choice) || choice < 0 || choice >= w.prediction.choices.length) throw new Error("Dự đoán không hợp lệ.");
    if (state.widgetAnswers.has(id) || state.skipped.has(`widget:${id}`)) return;
    this.hub.store.append(paperId, { t: "r.widgetAnswer", at: Date.now(), id, choice, correct: choice === w.prediction.right });
    this.hub.touch(paperId);
  }
}
