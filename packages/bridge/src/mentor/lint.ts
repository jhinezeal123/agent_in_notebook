// What can be said about an exercise against the content protocol
// (mentor-catalog/PROTOCOL.md) without running it: enough tests with names
// the learner can read, enough broken solutions and questions, hints that fit
// their level and give no line of the solution away, the starter and the
// reference defining what the tests call. Running it is verify.ts.

import type { Exercise } from "./catalog.js";

export interface LintIssue {
  /** error: the exercise does not follow the protocol; warn: it does, but is weaker than it should be. */
  level: "error" | "warn";
  text: string;
}

const TAG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The test functions of a tests.py: name, parameters, and whether a docstring follows. */
export function testFunctions(tests: string): { name: string; params: string; doc: boolean }[] {
  return [...tests.matchAll(/^def (test_\w+)\(([^)]*)\)\s*:[ \t]*\r?\n[ \t]+(\S.*)$/gm)].map((m) => ({
    name: m[1]!,
    params: m[2]!.replace(/\s+/g, ""),
    doc: /^[rRuU]?("""|'''|"|')/.test(m[3]!),
  }));
}

/** Lines of code in a hint: those inside ``` fences. */
function fencedLines(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) out.push(...m[1]!.split("\n").filter((l) => l.trim()));
  return out;
}

function defines(source: string, name: string): boolean {
  return new RegExp(`^(?:async\\s+def|def|class)\\s+${name}\\b|^${name}\\s*(?::[^=\\n]+)?=`, "m").test(source);
}

export function lintExercise(ex: Exercise): LintIssue[] {
  const issues: LintIssue[] = [];
  const error = (text: string) => issues.push({ level: "error", text });
  const warn = (text: string) => issues.push({ level: "warn", text });
  /** Content added by the protocol (a pack) is held to all of it; the original set only to what the machine needs. */
  const strict = !!ex.pack;
  const must = strict ? error : warn;
  const experiment = ex.role === "experiment";

  // Tests.
  const tests = testFunctions(ex.tests);
  const testsNeeded = experiment ? 1 : 4;
  if (tests.length < testsNeeded) error(`tests.py có ${tests.length} test (cần ≥ ${testsNeeded})`);
  for (const t of tests) {
    if (t.params !== "user,ref") error(`${t.name} phải có chữ ký (user, ref)`);
    if (!t.doc) must(`${t.name} chưa có docstring một dòng (là tên test người học thấy)`);
  }

  // Broken solutions.
  const mutantsNeeded = experiment ? 1 : 3;
  if (ex.mutants.length < Math.min(2, mutantsNeeded)) error(`${ex.mutants.length} bản sai trong mutants/ (cần ≥ ${mutantsNeeded})`);
  else if (ex.mutants.length < mutantsNeeded) must(`${ex.mutants.length} bản sai trong mutants/ (giao thức cần ≥ ${mutantsNeeded})`);

  // Questions.
  if (ex.probeBank.length < ex.probes) error(`probes.json có ${ex.probeBank.length} câu, ít hơn số câu bảo vệ ("probes": ${ex.probes})`);
  else if (ex.probeBank.length < ex.probes + 1) must(`probes.json có ${ex.probeBank.length} câu (cần ≥ "probes" + 1 = ${ex.probes + 1}, để lần ôn không lặp câu)`);
  const seen = new Set<string>();
  for (const p of ex.probeBank) {
    if (!TAG.test(p.tag)) must(`tag "${p.tag}" phải là kebab-case (chữ thường, số, gạch ngang)`);
    if (seen.has(p.q.trim())) error(`câu hỏi lặp: "${p.q.slice(0, 50)}…"`);
    seen.add(p.q.trim());
  }

  // Hints.
  const testNames = new Set(tests.map((t) => t.name));
  const refLines = ex.reference.split("\n").map((l) => l.trim()).filter((l) => l.length > 25 && !ex.starter.includes(l) && !ex.given.includes(l));
  for (const h of ex.hints) {
    const label = `hint mức ${h.level}${h.when ? ` ("${h.when.slice(0, 30)}")` : ""}`;
    if (h.test && !testNames.has(h.test)) error(`${label} nhắc tới test không có: ${h.test}`);
    const code = fencedLines(h.text);
    if (h.level <= 1 && code.length) error(`${label} có code; mức 0 và 1 chỉ là lời`);
    if (h.level === 3 && code.length > 8) error(`${label} có ${code.length} dòng code (tối đa 8)`);
    if (h.level <= 2) {
      const leaked = refLines.find((l) => h.text.includes(l));
      if (leaked) error(`${label} chứa nguyên một dòng của lời giải: ${leaked.slice(0, 60)}`);
    }
    if (h.level === 0 && !/[?？]/.test(h.text)) warn(`${label} nên là một câu hỏi ngược`);
  }
  if (strict && !experiment) {
    for (const level of [1, 2, 3]) if (!ex.hints.some((h) => h.level === level)) error(`hints.json thiếu hint mức ${level}`);
    if (!ex.hints.some((h) => h.level === 0)) warn("hints.json nên có ít nhất một câu hỏi ngược (mức 0), tốt nhất gắn với một test");
  }

  // What the tests call must be in the starter and in the reference.
  if (!experiment) {
    for (const f of ex.functions) {
      if (!defines(ex.starter, f)) error(`starter.py chưa khai ${f} (có trong "functions")`);
      if (!defines(ex.reference, f)) error(`reference.py chưa định nghĩa ${f} (có trong "functions")`);
      if (!ex.brief.includes(f)) warn(`brief.md không nhắc tới ${f}`);
    }
  }
  if (/^\s*(import|from)\s+\w/m.test(ex.starter)) warn("starter.py có import; import đặt ở \"prelude\" trong meta.json");

  // PyTorch must be declared: the catalog only offers such an exercise once it is verified on Kaggle.
  const usesTorch = [ex.prelude, ex.reference, ex.tests, ex.given].some((s) => /^\s*(import torch|from torch)\b/m.test(s));
  if (usesTorch && !ex.requires.includes("torch")) error("bài dùng torch nhưng \"requires\" chưa có \"torch\"");

  // The formula lab.
  if (!ex.variantOf && !experiment) {
    const code = ex.lab.filter((c) => c.type === "code");
    if (!code.length) must("lab.py chưa có cell code nào (Phòng công thức)");
    else if (!code.some((c) => /\bplt\.|\.plot\(|imshow\(/.test(c.source))) warn("lab.py chưa vẽ hình nào (matplotlib)");
  }
  return issues;
}
