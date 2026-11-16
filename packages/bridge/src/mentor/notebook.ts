// The learner's notebook for one exercise: the brief, the formula lab, a
// sketch cell, and the solution cell(s) the judge reads. Neither the
// reference solution nor the tests are written into it.

import { MENTOR_SKILL_LABEL, type CellInfo, type MentorKind, type MentorScaffold } from "@ainb/protocol";
import { toIpynb } from "../notebook/ipynb.js";
import type { Exercise } from "./catalog.js";

/** Marks a cell the judge runs. More than one cell may carry it; they run in order. */
export const SOLUTION_MARK = "#| mentor: solution";
export const SOLUTION_ID = "mentor-solution";
/** A variation's prediction cell. */
export const PREDICT_ID = "mentor-predict";
export const PREDICT_PLACEHOLDER = "_Dự đoán của bạn…_";

export function isSolutionCell(cell: Pick<CellInfo, "id" | "source" | "type">): boolean {
  return cell.type === "code" && (cell.id.startsWith(SOLUTION_ID) || cell.source.split("\n").some((l) => l.trim() === SOLUTION_MARK));
}

export interface NotebookOptions {
  kind?: MentorKind;
  scaffold?: MentorScaffold;
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
    `# ${ex.title}`,
    "",
    `> ⏱ khoảng ${ex.minutes} phút · độ khó ${ex.difficulty} · ${skills}`,
    "",
    ex.brief,
  ].join("\n"));
  if (ex.predict) {
    md("mentor-lab", [
      "## 1 · Dự đoán trước",
      "",
      `Đây là **biến thể** của một bài bạn đã làm. Trước khi code, viết dự đoán của bạn vào cell dưới (vài câu, có lý do), rồi gửi cho mentor. Sau khi qua máy chấm, bạn sẽ so dự đoán với thực tế.`,
      "",
      `> ${ex.predict.replace(/\n/g, "\n> ")}`,
    ].join("\n"));
    ex.lab.forEach((c, i) => (c.type === "code" ? code(`mentor-lab-${i + 1}`, c.source) : md(`mentor-lab-${i + 1}`, c.source)));
    md(PREDICT_ID, PREDICT_PLACEHOLDER);
  } else if (ex.lab.length) {
    md("mentor-lab", [
      "## 1 · Phòng công thức",
      "",
      "Chạy từng cell dưới đây và nhìn kỹ hình. Rồi **kể lại công thức bằng lời của bạn** cho mentor trong khung chat: nó làm gì với dữ liệu, vì sao có từng thành phần.",
    ].join("\n"));
    ex.lab.forEach((c, i) => (c.type === "code" ? code(`mentor-lab-${i + 1}`, c.source) : md(`mentor-lab-${i + 1}`, c.source)));
  }
  md("mentor-sketch-head", [
    "## 2 · Phác thảo",
    "",
    "Trước khi code: viết vào cell dưới cách bạn chia bài — các bước, **shape vào/ra của từng bước**, chỗ nào dễ sai. Gửi cho mentor để được phản biện.",
  ].join("\n"));
  md("mentor-sketch", "_Phác thảo của bạn…_");
  md("mentor-build-head", [
    "## 3 · Bài làm",
    "",
    `Code trong cell có dòng \`${SOLUTION_MARK}\` (giữ nguyên dòng đó; thêm cell mới thì chép dòng đó vào đầu cell). Xong bấm **Chấm bài** trong khung chat.`,
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
