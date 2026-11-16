// The learner's notebook for one exercise: the brief, the formula lab, a
// sketch cell, and the solution cell(s) the judge reads. Neither the
// reference solution nor the tests are written into it. The bridge writes
// these cells into a notebook open in Chrome (Kaggle), where the cell ids are
// the editor's own: the cells that matter carry a mark in their source.

import { MENTOR_SKILL_LABEL, type CellInfo, type MentorKind, type MentorScaffold } from "@ainb/protocol";
import { toIpynb } from "../notebook/ipynb.js";
import type { Exercise } from "./catalog.js";

/** Marks a cell the judge runs. More than one cell may carry it; they run in order. */
export const SOLUTION_MARK = "#| mentor: solution";
/** The learner's passed code of the exercises this one builds on (rebuilt from the store, never judged). */
export const CARRIED_MARK = "#| mentor: carried";
/** Code given with the exercise (data, boilerplate): the learner runs it, the judge runs its own copy. */
export const GIVEN_MARK = "#| mentor: given";
export const SOLUTION_ID = "mentor-solution";
/** A variation's prediction cell. */
export const PREDICT_ID = "mentor-predict";
export const PREDICT_PLACEHOLDER = "_Dự đoán của bạn…_";
export const SKETCH_PLACEHOLDER = "_Phác thảo của bạn…_";

/** The mark on the first line of a markdown cell (hidden once rendered). */
function mark(role: string): string {
  return `<!-- mentor: ${role} -->`;
}
const MARK_RE = /^<!-- mentor: ([\w-]+)(?: ([\w-]+))? -->\s*$/;

export function isSolutionCell(cell: Pick<CellInfo, "id" | "source" | "type">): boolean {
  return cell.type === "code" && (cell.id.startsWith(SOLUTION_ID) || cell.source.split("\n").some((l) => l.trim() === SOLUTION_MARK));
}

type Role = "brief" | "sketch" | "predict" | "solution" | "carried" | "given";

/** Code without the Mentor marks, so carried code is never taken for a solution cell. */
export function unmarkedCode(source: string): string {
  return source.split("\n").filter((l) => !/^#\| mentor: /.test(l.trim())).join("\n").trim();
}

/** What a cell is in an exercise, by its mark (or, in a notebook the bridge wrote as a file, its id). */
export function cellRole(cell: Pick<CellInfo, "id" | "source" | "type">): Role | null {
  if (isSolutionCell(cell)) return "solution";
  if (cell.type === "code") {
    const first = cell.source.split("\n", 1)[0]!.trim();
    return first === CARRIED_MARK ? "carried" : first === GIVEN_MARK ? "given" : null;
  }
  if (cell.type !== "markdown") return null;
  const m = cell.source.split("\n", 1)[0]!.trim().match(MARK_RE);
  if (m) return m[1] === "sketch" || m[1] === "predict" ? m[1] : m[1] === "exercise" ? "brief" : null;
  if (cell.id === "mentor-sketch") return "sketch";
  if (cell.id === PREDICT_ID) return "predict";
  return null;
}

/** The exercise a notebook holds, from its brief's mark. */
export function exerciseIn(cells: Pick<CellInfo, "id" | "source" | "type">[]): string | null {
  for (const c of cells) {
    if (c.type !== "markdown") continue;
    const m = c.source.split("\n", 1)[0]!.trim().match(MARK_RE);
    if (m?.[1] === "exercise" && m[2]) return m[2];
  }
  return null;
}

/** The paper a notebook is the workshop of, from its first cell's mark. */
export function paperIn(cells: Pick<CellInfo, "id" | "source" | "type">[]): string | null {
  for (const c of cells) {
    if (c.type !== "markdown") continue;
    const m = c.source.split("\n", 1)[0]!.trim().match(MARK_RE);
    if (m?.[1] === "paper" && m[2]) return m[2];
  }
  return null;
}

/** Non-empty cells that are not part of a Mentor exercise or workshop (the notebook's own content). */
export function foreignCells(cells: Pick<CellInfo, "id" | "source" | "type">[]): number {
  return exerciseIn(cells) || paperIn(cells) ? 0 : cells.filter((c) => c.source.trim()).length;
}

/** The learner's own writing in an exercise's notebook: kept when another exercise takes the notebook. */
export interface LearnerWork {
  sketch?: string;
  predict?: string;
  solution: string[];
}

function unmarked(source: string): string {
  const lines = source.split("\n");
  if (MARK_RE.test(lines[0]!.trim())) lines.shift();
  return lines.join("\n").trim();
}

export function learnerWork(cells: Pick<CellInfo, "id" | "source" | "type">[]): LearnerWork {
  const work: LearnerWork = { solution: [] };
  for (const c of cells) {
    const role = cellRole(c);
    if (role === "solution") work.solution.push(c.source);
    else if (role === "sketch" || role === "predict") {
      const text = unmarked(c.source);
      if (text && text !== SKETCH_PLACEHOLDER && text !== PREDICT_PLACEHOLDER) work[role] = text;
    }
  }
  return work;
}

/** The exercise's cells with the learner's saved work put back in place. */
export function withWork(cells: CellInfo[], work: LearnerWork | null): CellInfo[] {
  if (!work) return cells;
  return cells.map((c) => {
    const role = cellRole(c);
    if (role === "solution" && work.solution.length) return { ...c, source: work.solution.join("\n\n") };
    if ((role === "sketch" || role === "predict") && work[role]) return { ...c, source: `${mark(role)}\n${work[role]}` };
    return c;
  });
}

export interface NotebookOptions {
  kind?: MentorKind;
  scaffold?: MentorScaffold;
  /** The code the exercise builds on: the paper's given code and the learner's passed solutions (Mentor.carriedCode). */
  carried?: string;
}

const SCAFFOLD_NOTE: Record<MentorScaffold, string> = {
  full: "",
  signature: "Khung code chỉ còn chữ ký hàm (rating của bạn đã đủ để tự đọc đề lấy shape).",
  blank: "Cell bài làm để trống: tự dựng từ đầu theo đề.",
};

/**
 * The starter as the scaffold allows: as written, the `def` lines only (each
 * with `...` as its body), or nothing but a comment naming the functions.
 */
export function scaffoldStarter(ex: Pick<Exercise, "starter" | "functions">, scaffold: MentorScaffold): string {
  if (scaffold === "full") return ex.starter;
  if (scaffold === "blank") return `# Viết ${ex.functions.map((f) => `${f}(...)`).join(", ")} ở đây.`;
  const out: string[] = [];
  let open: string[] | null = null;
  for (const line of ex.starter.split("\n")) {
    if (open) {
      open.push(line);
      if (/:\s*(#.*)?$/.test(line)) {
        out.push(...open, `${" ".repeat(open[0]!.search(/\S/) + 4)}...`, "");
        open = null;
      }
      continue;
    }
    if (/^\s*def\s/.test(line)) {
      if (/:\s*(#.*)?$/.test(line)) out.push(line, `${" ".repeat(line.search(/\S/) + 4)}...`, "");
      else open = [line];
    }
  }
  return out.join("\n").trimEnd() || ex.starter;
}

export function exerciseCells(ex: Exercise, opts: NotebookOptions = {}): CellInfo[] {
  const kind = opts.kind ?? "learn";
  const scaffold = opts.scaffold ?? (kind === "review" ? "blank" : "full");
  if (kind === "review") return reviewCells(ex);
  const cells: Omit<CellInfo, "index">[] = [];
  const md = (id: string, source: string) => cells.push({ id, type: "markdown", source, executionCount: null, outputs: [] });
  const code = (id: string, source: string) => cells.push({ id, type: "code", source, executionCount: null, outputs: [] });
  const skills = ex.skills.map((s) => MENTOR_SKILL_LABEL[s]).join(" · ");
  md("mentor-brief", [
    mark(`exercise ${ex.id}`),
    `# ${ex.title}`,
    "",
    `> ⏱ khoảng ${ex.minutes} phút · độ khó ${ex.difficulty} · ${skills}${ex.cites ? ` · trong paper: ${ex.cites}` : ""}`,
    "",
    ex.brief,
  ].join("\n"));
  if (ex.predict) {
    md("mentor-lab", [
      "## 1 · Dự đoán trước",
      "",
      ex.role === "experiment"
        ? "Đây là **thí nghiệm** của paper. Trước khi train, viết dự đoán của bạn vào cell dưới (loss sẽ đi thế nào, con số cuối khoảng bao nhiêu, vì sao), rồi gửi cho mentor. Train xong, bấm Chấm bài: máy chấm tự đo trên mô hình đang nằm trong máy."
        : "Đây là **biến thể** của một bài bạn đã làm. Trước khi code, viết dự đoán của bạn vào cell dưới (vài câu, có lý do), rồi gửi cho mentor. Sau khi qua máy chấm, bạn sẽ so dự đoán với thực tế.",
      "",
      `> ${ex.predict.replace(/\n/g, "\n> ")}`,
    ].join("\n"));
    ex.lab.forEach((c, i) => (c.type === "code" ? code(`mentor-lab-${i + 1}`, c.source) : md(`mentor-lab-${i + 1}`, c.source)));
    md(PREDICT_ID, `${mark("predict")}\n${PREDICT_PLACEHOLDER}`);
  } else if (ex.lab.length) {
    md("mentor-lab", [
      "## 1 · Phòng công thức",
      "",
      "Chạy từng cell dưới đây và nhìn kỹ hình. Rồi **kể lại công thức bằng lời của bạn** cho mentor trong khung chat: nó làm gì với dữ liệu, vì sao có từng thành phần.",
    ].join("\n"));
    ex.lab.forEach((c, i) => (c.type === "code" ? code(`mentor-lab-${i + 1}`, c.source) : md(`mentor-lab-${i + 1}`, c.source)));
  }
  if (opts.carried?.trim()) {
    md("mentor-carried-head", "## Code của bạn từ các bài trước\n\nBài này dựng tiếp trên code bạn đã viết và đã qua máy chấm (cùng phần cho sẵn của paper). **Chạy cell dưới trước.** Máy chấm dùng bản đã lưu, không đọc cell này.");
    code("mentor-carried", `${CARRIED_MARK}\n${opts.carried.trim()}`);
  }
  if (ex.given.trim()) {
    md("mentor-given-head", "## Code cho sẵn\n\nPhần này không thuộc ý tưởng cần học (dữ liệu, vẽ hình, boilerplate). Chạy nó trước bài làm.");
    code("mentor-given", `${GIVEN_MARK}\n${ex.given.trim()}`);
  }
  md("mentor-sketch-head", [
    "## 2 · Phác thảo",
    "",
    "Trước khi code: viết vào cell dưới cách bạn chia bài — các bước, **shape vào/ra của từng bước**, chỗ nào dễ sai. Gửi cho mentor để được phản biện.",
  ].join("\n"));
  md("mentor-sketch", `${mark("sketch")}\n${SKETCH_PLACEHOLDER}`);
  md("mentor-build-head", [
    "## 3 · Bài làm",
    "",
    `Code trong cell có dòng \`${SOLUTION_MARK}\` (giữ nguyên dòng đó; thêm cell mới thì chép dòng đó vào đầu cell). Xong bấm **Chấm bài** trong khung chat. Cell phác thảo ở trên thì giữ dòng đầu \`<!-- mentor: … -->\`.`,
    `Các hàm cần có: ${ex.functions.map((f) => `\`${f}\``).join(", ")}.`,
    ...(SCAFFOLD_NOTE[scaffold] ? ["", `> ${SCAFFOLD_NOTE[scaffold]}`] : []),
  ].join("\n"));
  code(SOLUTION_ID, [SOLUTION_MARK, ex.prelude, "", scaffoldStarter(ex, scaffold)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
  md("mentor-try-head", "## Thử nhanh\n\nCell dưới để bạn tự thử; nó không được chấm.");
  code("mentor-try", "# Thử code của bạn ở đây");
  return cells.map((c, index) => ({ ...c, index }));
}

/** A spaced review: the brief and a blank solution cell, nothing else to look at. */
function reviewCells(ex: Exercise): CellInfo[] {
  const cells: Omit<CellInfo, "index">[] = [
    {
      id: "mentor-brief",
      type: "markdown",
      source: [
        mark(`exercise ${ex.id}`),
        `# Ôn lại: ${ex.title}`,
        "",
        "> 🔁 Khởi động khoảng 8 phút: **cài lại từ cell trống**, đừng mở bài cũ. Qua máy chấm mà không cần gợi ý quá mức 1 thì lần ôn sau giãn ra (3 → 10 → 30 ngày).",
        "",
        ex.brief,
      ].join("\n"),
      executionCount: null,
      outputs: [],
    },
    {
      id: "mentor-build-head",
      type: "markdown",
      source: `## Bài làm\n\nCode trong cell có dòng \`${SOLUTION_MARK}\`, rồi bấm **Chấm bài** trong khung chat. Các hàm cần có: ${ex.functions.map((f) => `\`${f}\``).join(", ")}.`,
      executionCount: null,
      outputs: [],
    },
    { id: SOLUTION_ID, type: "code", source: [SOLUTION_MARK, ex.prelude, "", scaffoldStarter(ex, "blank")].join("\n"), executionCount: null, outputs: [] },
    { id: "mentor-try", type: "code", source: "# Thử code của bạn ở đây (không được chấm)", executionCount: null, outputs: [] },
  ];
  return cells.map((c, index) => ({ ...c, index }));
}

export function exerciseNotebook(ex: Exercise, opts: NotebookOptions = {}): string {
  return toIpynb(exerciseCells(ex, opts), "python");
}
