// The learner's notebook for one exercise: the brief, the formula lab, a
// sketch cell, and the solution cell(s) the judge reads. Neither the
// reference solution nor the tests are written into it.

import type { CellInfo } from "@ainb/protocol";
import { toIpynb } from "../notebook/ipynb.js";
import type { Exercise } from "./catalog.js";
import { MENTOR_SKILL_LABEL } from "@ainb/protocol";

/** Marks a cell the judge runs. More than one cell may carry it; they run in order. */
export const SOLUTION_MARK = "#| mentor: solution";
export const SOLUTION_ID = "mentor-solution";

export function isSolutionCell(cell: Pick<CellInfo, "id" | "source" | "type">): boolean {
  return cell.type === "code" && (cell.id.startsWith(SOLUTION_ID) || cell.source.split("\n").some((l) => l.trim() === SOLUTION_MARK));
}

export function exerciseCells(ex: Exercise): CellInfo[] {
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
  if (ex.lab.length) {
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
  ].join("\n"));
  code(SOLUTION_ID, [SOLUTION_MARK, ex.prelude, "", ex.starter].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd());
  md("mentor-try-head", "## Thử nhanh\n\nCell dưới để bạn tự thử; nó không được chấm.");
  code("mentor-try", "# Thử code của bạn ở đây");
  return cells.map((c, index) => ({ ...c, index }));
}

export function exerciseNotebook(ex: Exercise): string {
  return toIpynb(exerciseCells(ex), "python");
}
