import { createPortal } from "preact/compat";
import { useLayoutEffect, useState } from "preact/hooks";
import { readerCompute, type ReaderWidgetModel, type ReaderWidgetView } from "@ainb/protocol";
import type { GuideActions } from "./guide.js";
import { Cite, Md } from "./bits.js";

export function ReaderWidgets({ widgets, root, version, actions }: {
  widgets: ReaderWidgetView[]; root: HTMLElement | null; version: number; actions: GuideActions;
}) {
  const anchors = Array.from(new Set(widgets.flatMap((w) => w.anchor.id ? [w.anchor.id] : []))).sort().join("\n");
  const [slots, setSlots] = useState<Map<string, HTMLElement>>(new Map());
  useLayoutEffect(() => {
    const next = new Map<string, HTMLElement>();
    for (const id of anchors.split("\n").filter(Boolean)) {
      const node = root?.querySelector(`#${CSS.escape(id)}`);
      const target = node?.closest("table, .ltx_equation, .ltx_equationgroup") ?? node;
      if (!target) continue;
      const slot = document.createElement("div");
      slot.className = "er-widget-slot";
      target.after(slot);
      next.set(id, slot);
    }
    setSlots(next);
    return () => { for (const slot of next.values()) slot.remove(); };
  }, [anchors, root, version]);
  return <>{[...slots].map(([id, slot]) => createPortal(
    <>{widgets.filter((w) => w.anchor.id === id).map((w) => <Widget key={w.id} widget={w} actions={actions} />)}</>, slot,
  ))}</>;
}

export function Widget({ widget, actions }: { widget: ReaderWidgetView; actions: GuideActions }) {
  const [choice, setChoice] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState("");
  async function submit() {
    if (choice === undefined) return;
    setBusy(true);
    try { await actions.act("reader.widget.answer", { id: widget.id, choice }); }
    catch { /* the reader shows the error */ }
    finally { setBusy(false); }
  }
  return <details class="er-widget">
    <summary><Md text={widget.title} class="er-inline" /></summary>
    <div class="er-row">{widget.evidence?.map(({ anchor, quote }, i) => <Cite key={i} anchor={{ id: anchor, quote }} onCite={actions.cite} />)}</div>
    {widget.prediction && !widget.model && <div>
      <Md text={widget.prediction.question} onCite={actions.cite} />
      {widget.prediction.choices.map((option, index) => <label key={option}>
        <input type="radio" name={`prediction-${widget.id}`} checked={choice === index} onChange={() => setChoice(index)} /> <Md text={option} class="er-inline" />
      </label>)}
      <button class="er-btn primary" disabled={busy || choice === undefined} onClick={() => void submit()}>Chốt dự đoán</button>
      <button class="er-link" disabled={busy} onClick={() => void actions.act("reader.skip", { task: `widget:${widget.id}` }).catch(() => {})}>Cho xem luôn</button>
    </div>}
    {widget.result && <p role="status">{widget.result.correct ? "Dự đoán đúng." : "Dự đoán chưa đúng. Thử thay đổi tham số để xem vì sao."}</p>}
    {(widget.result?.right ?? widget.right) !== undefined && <p>Đáp án · <Md text={widget.prediction?.choices[(widget.result?.right ?? widget.right)!] ?? ""} class="er-inline" /></p>}
    {widget.explanation && <Md text={widget.explanation} onCite={actions.cite} />}
    {widget.model && <Model model={widget.model} />}
    {!!widget.tryThis.length && <div><b>Thử điều này</b><ul>{widget.tryThis.map((s) => <li key={s}><Md text={s} /></li>)}</ul></div>}
    {widget.model && <button class="er-btn" onClick={() => void actions.act("lab", { widget: widget.id }).catch(() => {})}>Mở thành lab trên notebook</button>}
    {report ? <form onSubmit={(event) => {
      event.preventDefault();
      void actions.act("reader.report", { item: `widget:${widget.id}`, reason: reason.trim() }).catch(() => {});
    }}><label>Lỗi trong ví dụ <input value={reason} onInput={(e) => setReason(e.currentTarget.value)} required /></label>
      <button class="er-btn" type="submit">Gửi và ẩn ví dụ</button>
      <button class="er-link" type="button" onClick={() => setReport(false)}>Hủy</button>
    </form> : <button class="er-link" onClick={() => setReport(true)}>Báo ví dụ sai</button>}
  </details>;
}

function Model({ model }: { model: ReaderWidgetModel }) {
  const [inputs, setInputs] = useState(() => Object.fromEntries(model.params.map((p) => [p.name, p.init])));
  const [compare, setCompare] = useState<Record<string, number> | null>(null);
  const [step, setStep] = useState(0);
  const update = (name: string, value: number) => setInputs({ ...inputs, [name]: value });
  const shown = model.steps ? [model.outputs[step]!] : model.outputs;
  return <>
    {model.params.map((p) => <label key={p.name}><Md text={p.label} class="er-inline" />{" "}
      {p.toggle ? <input type="checkbox" checked={inputs[p.name] === p.max} onChange={(e) => update(p.name, e.currentTarget.checked ? p.max : p.min)} />
        : p.options ? <select value={inputs[p.name]} onChange={(e) => update(p.name, Number(e.currentTarget.value))}>
          {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select> : <><output>{format(inputs[p.name]!)}</output>
          <input type="range" min={p.min} max={p.max} step={p.step} value={inputs[p.name]} onInput={(e) => update(p.name, e.currentTarget.valueAsNumber)} />
        </>}
    </label>)}
    {model.steps && <div class="er-row">
      <button class="er-btn" disabled={step === 0} onClick={() => setStep((i) => i - 1)}>Bước trước</button>
      <span>{step + 1}/{model.outputs.length}</span>
      <button class="er-btn" disabled={step + 1 === model.outputs.length} onClick={() => setStep((i) => i + 1)}>Bước tiếp</button>
    </div>}
    {model.matrix ? <div class="er-row">
      {compare && <Matrix model={model} inputs={compare} label="Mốc so sánh" />}
      <Matrix model={model} inputs={inputs} label="Hiện tại" />
    </div> : <table><thead><tr><th>Đại lượng</th>{compare && <th>Mốc so sánh</th>}<th>Hiện tại</th></tr></thead>
      <tbody>{shown.map((o, i) => <tr key={i}><th scope="row"><Md text={o.label} class="er-inline" /></th>
        {compare && <td>{format(readerCompute(o.expression, compare))}</td>}
        <td>{format(readerCompute(o.expression, inputs))}</td>
      </tr>)}</tbody>
    </table>}
    {model.series && <Plot model={model} inputs={inputs} />}
    <button class="er-btn" onClick={() => setCompare(compare ? null : inputs)}>{compare ? "Bỏ mốc so sánh" : "Giữ cấu hình để so sánh"}</button>
  </>;
}

function Matrix({ model, inputs, label }: { model: ReaderWidgetModel; inputs: Record<string, number>; label: string }) {
  const { rows, columns, heatmap } = model.matrix!;
  const values = model.outputs.map((o) => readerCompute(o.expression, inputs));
  const max = Math.max(1e-12, ...values.filter(Number.isFinite).map(Math.abs));
  return <table><caption>{label}</caption><tbody>
    {Array.from({ length: rows }, (_, row) => <tr key={row}>{values.slice(row * columns, (row + 1) * columns).map((value, col) =>
      <td key={col} title={model.outputs[row * columns + col]?.label} style={heatmap && Number.isFinite(value)
        ? { background: `color-mix(in srgb, var(--vscode-textLink-foreground) ${Math.round(Math.abs(value) / max * 45)}%, transparent)` } : undefined}>{format(value)}</td>)}</tr>)}
  </tbody></table>;
}

function Plot({ model, inputs }: { model: ReaderWidgetModel; inputs: Record<string, number> }) {
  const series = model.series!;
  const output = model.outputs[0]!;
  const values = Array.from({ length: series.count }, (_, i) => readerCompute(output.expression, {
    ...inputs, [series.axis]: series.min + (series.max - series.min) * i / (series.count - 1),
  }));
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const points = values.map((y, i) => ({ x: 8 + i * 304 / (values.length - 1), y: max === min ? 55 : 102 - 94 * (y - min) / (max - min), shown: Number.isFinite(y) }));
  const path = points.map((p, i) => p.shown ? `${points[i - 1]?.shown ? "L" : "M"}${p.x} ${p.y}` : "").join(" ");
  return <figure class="er-widget-plot">
    <svg viewBox="0 0 320 110" role="img" aria-label={`${output.label}: ${format(min)}–${format(max)}`}>
      {series.style === "points" ? points.map((p, i) => p.shown && <circle key={i} cx={p.x} cy={p.y} r="2.5" fill="currentColor" />)
        : <path d={path} fill="none" stroke="currentColor" stroke-width="2" />}
    </svg>
    <figcaption>{output.label} ({format(min)}–{format(max)}) · {series.axis} ({format(series.min)}–{format(series.max)})</figcaption>
  </figure>;
}

function format(n: number): string {
  return Number.isFinite(n) ? new Intl.NumberFormat("vi", { maximumSignificantDigits: 7 }).format(n) : "Không xác định";
}
