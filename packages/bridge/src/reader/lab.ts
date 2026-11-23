import type { ReaderExpr, ReaderWidgetModel } from "@ainb/protocol";
import type { ReaderHub } from "./index.js";

function python(expression: ReaderExpr): string {
  if (typeof expression === "number") return String(expression);
  if (typeof expression === "string") return `params[${JSON.stringify(expression)}]`;
  const [op, ...args] = expression;
  const [a, b] = args.map((arg) => python(arg as ReaderExpr));
  switch (op) {
    case "+": case "-": case "*": case "/": return `(${a} ${op} ${b})`;
    case "pow": return `((${a}) ** (${b}))`;
    case "abs": return `abs(${a})`;
    case "sqrt": case "log": case "exp": return `math.${op}(${a})`;
    case "min": case "max": return `${op}(${a}, ${b})`;
    default: throw new Error("Không thể chuyển phép tính của ví dụ sang Python.");
  }
}

function source(model: ReaderWidgetModel): string {
  const inputs = model.params.map((p) => `    ${JSON.stringify(p.name)}: ${p.init},`).join("\n");
  const outputs = model.outputs.map((v, i) => `output_${i + 1} = ${python(v.expression)}\nprint(${JSON.stringify(v.label + ":")}, output_${i + 1})`).join("\n");
  return `import math\n\nparams = {\n${inputs}\n}\n\n${outputs}`;
}

export function readerLab(hub: ReaderHub, paperId: string, widgetId: string): { type: "markdown" | "code"; source: string }[] {
  const w = hub.widgets.read(paperId, widgetId);
  if (!w || !hub.widgets.views(paperId).some((v) => v.id === widgetId && v.model)) throw new Error("Mở ví dụ tương tác trước khi tạo lab.");
  const meta = hub.meta(paperId);
  const quotes = w.evidence.map(({ quote }) => `> ${quote.replace(/\s+/g, " ")}`).join("\n\n");
  return [
    { type: "markdown", source: `# ${w.title}\n\nPaper: ${meta.title} (${w.anchor.id ?? ""})\n\n${quotes}\n\n${w.explanation}` },
    { type: "markdown", source: `## Dự đoán trước khi chạy\n\n${w.prediction?.question ?? "Điều gì thay đổi khi bạn chỉnh một tham số?"}\n\n${w.tryThis.map((s) => `- ${s}`).join("\n")}` },
    { type: "code", source: source(w.model) },
  ];
}
