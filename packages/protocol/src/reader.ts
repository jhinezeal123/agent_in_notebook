// Easy-read: reading a paper in its own tab, with a tutor in the chat beside
// it. What the bridge, the reading tab and the chat panel say to each other
// (docs/easy-read.md, E.9). The paper's full text (ReaderDoc) stays in the
// bridge; the tab gets the outline and the files to show.

/**
 * A place in the paper. `id` is an element of the paper's HTML (LaTeXML ids:
 * section "S4.SS1", paragraph "S4.SS1.p2", equation "S2.E1", figure "S1.F1",
 * table "S3.T1") or a PDF page ("page-4"); `quote` is the exact words (as the
 * W3C TextQuoteSelector), to find it where there is no id, or to narrow one.
 */
export interface ReaderAnchor {
  id?: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  /** A PDF page, from 1. */
  page?: number;
}

/** What the reader asks about a passage they selected. */
export type ReaderAskKind = "explain" | "example" | "notation" | "why";

export const READER_ASK_LABEL: Record<ReaderAskKind, string> = {
  explain: "Giải thích",
  example: "Ví dụ cụ thể",
  notation: "Ký hiệu",
  why: "Vì sao?",
};

export interface ReaderSectionView {
  id: string;
  /** "4.1"; absent for the abstract and unnumbered sections. */
  number?: string;
  title: string;
  level: 1 | 2 | 3;
  parent?: string;
  /** Minutes to read it (about 200 words a minute, formulas and figures count more). */
  minutes: number;
  /** Time spent on it so far. */
  readMs: number;
  /** Read: time of at least 40 % of the estimate, or marked by the reader. */
  read: boolean;
  /** No text of its own, only subsections (read when they all are; not counted on its own). */
  empty?: true;
}

/** One of the reader's notes, or a question they keep for later ("Câu hỏi của tôi"). */
export interface ReaderNote {
  id: string;
  kind: "note" | "question";
  text: string;
  anchor?: ReaderAnchor;
  at: number;
  /** A question the reader closed. */
  done?: boolean;
}

export interface ReaderView {
  paperId: string;
  title: string;
  authors?: string;
  year?: number;
  arxiv?: string;
  url?: string;
  /** What the tab shows: arXiv's HTML, or a PDF. */
  view: "html" | "pdf";
  /** What the tutor reads, which says how far its formulas can be trusted. */
  text: "html" | "latex" | "pdf";
  /** A PDF whose text the tab has not taken out yet (it does so with pdf.js, then sends `reader.pdfText`). */
  needsText?: boolean;
  /** The paper's reading folder on this machine; `file` in it is what the tab shows (doc.html or paper.pdf, with assets/ beside). */
  dir: string;
  file: string;
  sections: ReaderSectionView[];
  notes: ReaderNote[];
  /** The section the reader was in last. */
  at?: string;
  /** What went wrong in the conversion, for the reader to know (a few LaTeXML errors, a flattened PDF text). */
  warnings: string[];
  /** A PDF that is on arXiv (its id found on the first page): the arXiv version reads better. */
  arxivHint?: string;
  openedAt: number;
  lastAt: number;
  /** Why the reader reads it (ER-2); absent until they say. */
  goal?: ReaderGoal;
  /** The pass they are in (1 until a goal is chosen). */
  pass?: ReaderPass;
  /** Changes whenever the guide (`reader.guide`) does: the tab asks for it again. */
  guideRev?: number;
}

/** A paper in the reading list. */
export interface ReaderLibraryItem {
  paperId: string;
  title: string;
  authors?: string;
  year?: number;
  view: "html" | "pdf";
  lastAt: number;
  read: number;
  total: number;
}

/** What a chat that is a paper's tutor adds to its snapshot. */
export interface ReaderChat {
  paperId: string;
  title: string;
}

/** The key a paper's tutor chat is saved under (its transcript follows the paper). */
export function readerChatKey(paperId: string): string {
  return `reader:${paperId}`;
}

/** The paper of a tutor chat's key, or null. */
export function readerPaperOf(key: string | undefined): string | null {
  return key?.startsWith("reader:") ? key.slice(7) : null;
}

/**
 * A citation the tutor writes, `[[S4.SS1]]`, `[[S2.E1]]`, `[[page-4]]` or
 * `[[p4: "exact words"]]`, as an anchor; null when it is not one.
 */
export function parseReaderCite(inner: string): ReaderAnchor | null {
  const s = inner.trim();
  const page = s.match(/^p(?:age)?[\s-]?(\d{1,4})\s*:\s*["“](.+?)["”]$/s);
  if (page) return { page: Number(page[1]), quote: page[2]!.trim(), id: `page-${page[1]}` };
  const quote = s.match(/^["“](.+?)["”]$/s);
  if (quote) return { quote: quote[1]!.trim() };
  const pageOnly = s.match(/^(?:page-|p\.?\s?)(\d{1,4})$/i);
  if (pageOnly) return { id: `page-${pageOnly[1]}`, page: Number(pageOnly[1]) };
  const withQuote = s.match(/^([A-Za-z][\w.-]{0,60})\s*:\s*["“](.+?)["”]$/s);
  if (withQuote) return { id: withQuote[1]!, quote: withQuote[2]!.trim() };
  if (/^(?:abstract|bib\.bib\d+|[A-Z][A-Za-z]*\d[\w.]*|[A-Za-z]+\d+(?:\.[A-Za-z]+\d+)*)$/.test(s)) return { id: s };
  return null;
}

/** How a citation chip reads: "§4.1", "Eq. 3", "Fig. 1", "tr. 4". */
export function readerCiteLabel(anchor: ReaderAnchor, sections?: { id: string; number?: string; title: string }[]): string {
  const id = anchor.id ?? "";
  if (anchor.page && (!id || id.startsWith("page-"))) return anchor.quote ? `tr. ${anchor.page}: “${clip(anchor.quote, 28)}”` : `tr. ${anchor.page}`;
  if (!id) return `“${clip(anchor.quote ?? "", 32)}”`;
  if (id === "abstract") return "Abstract";
  const known = sections?.find((s) => s.id === id);
  if (known) return known.number ? `§${known.number}` : clip(known.title, 24);
  const last = id.split(".").pop() ?? id;
  const num = (re: RegExp) => last.match(re)?.[1];
  const eq = num(/^E(\d+)$/);
  if (eq) return `Eq. ${eq}`;
  const fig = num(/^F(\d+)$/);
  if (fig) return `Fig. ${fig}`;
  const tab = num(/^T(\d+)$/);
  if (tab) return `Table ${tab}`;
  const alg = id.match(/^alg(?:orithm)?(\d+)$/i)?.[1];
  if (alg) return `Alg. ${alg}`;
  if (id.startsWith("bib.")) return `[${id.replace(/^bib\.bib/, "")}]`;
  // A paragraph: its section's number and ¶n ("S4.SS1.p2" → §4.1 ¶2).
  const para = id.match(/^(.*)\.p(\d+)$/);
  if (para) {
    const sec = sections?.find((s) => s.id === para[1]);
    return `${sec?.number ? `§${sec.number}` : sectionNumber(para[1]!)} ¶${para[2]}`;
  }
  return sectionNumber(id);
}

/** "S4.SS1" → "§4.1", "A2" → "App. B". */
function sectionNumber(id: string): string {
  const parts = id.split(".");
  const nums: string[] = [];
  const appendix = /^A\d+$/.test(parts[0] ?? "");
  for (const [i, p] of parts.entries()) {
    const m = p.match(/^(?:S|SS|SSS)(\d+)$/);
    const app = i === 0 ? p.match(/^A(\d+)$/) : null;
    if (m) nums.push(m[1]!);
    else if (app && Number(app[1]) <= 26) nums.push(String.fromCharCode(64 + Number(app[1])));
    else break;
  }
  if (!nums.length) return id;
  return appendix ? `App. ${nums.join(".")}` : `§${nums.join(".")}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ------------------------------------------------------------------ ER-2: passes 1–2, guided (D.3, D.4, E.6, E.8)

/** Why the reader reads the paper (D.1): how far the passes go. */
export type ReaderGoal = "gist" | "use" | "deep";

export const READER_GOALS: { id: ReaderGoal; label: string; detail: string }[] = [
  { id: "gist", label: "Nắm ý", detail: "Biết paper làm gì, có đáng đọc kỹ không · lượt 1 · 10–15 phút" },
  { id: "use", label: "Hiểu để dùng", detail: "Áp dụng vào việc của mình · lượt 1–2 · 1–2 buổi" },
  { id: "deep", label: "Hiểu sâu", detail: "Dẫn lại được, phản biện được, có thể reproduce · đủ 4 lượt · 3–5 buổi" },
];

export type ReaderPass = 1 | 2 | 3 | 4;

export const READER_PASS_LABEL: Record<ReaderPass, string> = { 1: "Định hướng", 2: "Hiểu", 3: "Đào sâu", 4: "Ghi nhớ" };

/** The last pass a goal asks for. */
export function readerLastPass(goal: ReaderGoal | undefined): ReaderPass {
  return goal === "gist" ? 1 : goal === "use" ? 2 : 4;
}

/** What a paragraph does in the paper (Scim's facets), lit up when skimming in pass 1. */
export type ReaderRole = "objective" | "contribution" | "method" | "result" | "limitation";

export const READER_ROLE_LABEL: Record<ReaderRole, string> = {
  objective: "Mục tiêu",
  contribution: "Đóng góp",
  method: "Phương pháp",
  result: "Kết quả",
  limitation: "Hạn chế",
};

export type ReaderBloom = "remember" | "understand" | "apply" | "analyze" | "evaluate" | "create";

export const READER_BLOOMS: readonly ReaderBloom[] = ["remember", "understand", "apply", "analyze", "evaluate", "create"];

export const READER_BLOOM_LABEL: Record<ReaderBloom, string> = {
  remember: "Nhớ",
  understand: "Hiểu",
  apply: "Áp dụng",
  analyze: "Phân tích",
  evaluate: "Đánh giá",
  create: "Sáng tạo",
};

/** The five Cs of a first pass (Keshav), written by the reader in their own words. */
export type ReaderFiveC = "category" | "context" | "correctness" | "contributions" | "clarity";

export const READER_FIVE_C: { key: ReaderFiveC; label: string; prompt: string }[] = [
  { key: "category", label: "Category", prompt: "Paper thuộc loại gì: phương pháp mới, phân tích, hệ thống, benchmark…?" },
  { key: "context", label: "Context", prompt: "Nó dựa trên những paper, ý tưởng nào?" },
  { key: "correctness", label: "Correctness", prompt: "Các giả định có vẻ hợp lý không?" },
  { key: "contributions", label: "Contributions", prompt: "Đóng góp chính là gì?" },
  { key: "clarity", label: "Clarity", prompt: "Paper viết có rõ không?" },
];

/** A QALMRI sheet (Kosslyn & Rosenberg), for a section with an experiment. */
export type ReaderQalmriKey = "question" | "alternatives" | "logic" | "method" | "result" | "inference";

export const READER_QALMRI: { key: ReaderQalmriKey; label: string; prompt: string }[] = [
  { key: "question", label: "Câu hỏi", prompt: "Thí nghiệm muốn trả lời câu hỏi gì?" },
  { key: "alternatives", label: "Các giả thuyết", prompt: "Những câu trả lời cạnh tranh nào có thể đúng?" },
  { key: "logic", label: "Lập luận", prompt: "Nếu giả thuyết A đúng thì kết quả phải thế nào? Nếu B thì sao?" },
  { key: "method", label: "Phương pháp", prompt: "Biến độc lập, biến phụ thuộc, baseline là gì?" },
  { key: "result", label: "Kết quả", prompt: "Kết quả cho thấy gì (con số chính)?" },
  { key: "inference", label: "Kết luận", prompt: "Rút ra được gì, và bạn sẽ làm thí nghiệm nào tiếp?" },
];

/** The six questions to read a figure with (Carey et al.), and what to look at. */
export const READER_FIGURE_QUESTIONS: readonly string[] = [
  "Tác giả muốn biết điều gì?",
  "Họ đã làm gì để biết?",
  "Vì sao họ làm theo cách đó?",
  "Kết quả cho thấy gì?",
  "Tác giả diễn giải kết quả ra sao?",
  "Nên làm gì tiếp?",
  "Trục, đơn vị, màu và error bar nói gì?",
];

export type ReaderItemKind = "mcq" | "multi" | "twotier" | "numeric" | "order" | "match";

/** A checkpoint question as the tab shows it: no answer in it until it has been answered. */
export interface ReaderItemView {
  id: string;
  /** The unit (a section of pass 2) it checks. */
  unit: string;
  concept: string;
  bloom: ReaderBloom;
  kind: ReaderItemKind;
  /** Markdown with $TeX$. */
  stem: string;
  /** mcq, multi, twotier: in the order shown. */
  options?: string[];
  /** twotier: the reasons, in the order shown. */
  reasons?: string[];
  /** order: the steps, shuffled. */
  steps?: string[];
  /** match: each left gets one of the rights (shuffled). */
  lefts?: string[];
  rights?: string[];
  /** numeric: the unit of the answer. */
  measure?: string;
  difficulty: number;
  /** The last answer and what it showed. */
  result?: ReaderAnswerResult;
  /** Answered wrong, not right since: it comes back at the end of the session, and next time. */
  again?: true;
  /** The reader asked to see the answer without answering: it does not count. */
  skipped?: true;
}

/** An answer, as indices into what the view shows. */
export interface ReaderChoice {
  /** mcq: one; multi: one or more. */
  options?: number[];
  /** twotier: the reason. */
  reason?: number;
  /** numeric. */
  value?: number;
  /** order: the steps' shown indices, in the order chosen. */
  steps?: number[];
  /** match: for each left, the index of the right chosen. */
  pairs?: number[];
}

export interface ReaderAnswerResult {
  correct: boolean;
  /** twotier: the answer right and the reason not, or the reverse. */
  partly?: boolean;
  confidence: 1 | 2 | 3;
  /** Points for this answer (Gardner-Medwin, by how sure the reader said they were). */
  points: number;
  choice: ReaderChoice;
  /** The right answer, as indices into the view (numeric: its value). */
  right: ReaderChoice & { tolerance?: number };
  /** For each option (shown order): why it is right, or the misconception it stands for. */
  why?: string[];
  reasonsWhy?: string[];
  explain: string;
  evidence: { anchor: string; quote: string }[];
  at: number;
}

/** A pretest question (pass 1): a guess before reading, the answer shown once its section is read. */
export interface ReaderPretestView {
  id: string;
  /** The section whose reading opens the answer. */
  section: string;
  stem: string;
  /** Present for a multiple-choice guess; else the guess is written. */
  options?: string[];
  guess?: { option?: number; text?: string };
  /** Once the section is read (or the reader asked to see it). */
  answer?: { right?: number; text: string; explain: string; evidence: { anchor: string; quote: string }[] };
}

export type ReaderWriteKind = "5c" | "recall" | "explain" | "qalmri" | "summary" | "figure" | "predict";

export type ReaderGrade = 0 | 1 | 2;

/** Something the reader wrote in their own words, and how the tutor graded it. */
export interface ReaderWriteView {
  id: string;
  kind: ReaderWriteKind;
  unit?: string;
  /** A figure's or table's id (figure, predict). */
  key?: string;
  text: string;
  /** A form's fields (5C, QALMRI). */
  fields?: Record<string, string>;
  at: number;
  grade?: ReaderGrade;
  /** Per field (5C, QALMRI). */
  parts?: { key: string; grade: ReaderGrade; note?: string }[];
  missing?: string[];
  feedback?: string;
  /** Sent to the tutor; its grade has not come yet. */
  grading?: true;
}

export interface ReaderScore {
  answered: number;
  total: number;
  /** Right the first time. */
  firstRight: number;
  points: number;
  /** The most points the answers so far could have had. */
  max: number;
  /** Sure (3) and wrong: a real misconception. */
  sureWrong: number;
  /** A guess (1) and right: not solid yet. */
  luckyRight: number;
}

/** A section of pass 2 (a top section with its subsections), its checkpoint at the end. */
export interface ReaderUnitView {
  id: string;
  number?: string;
  title: string;
  sections: string[];
  /** All its sections read. */
  read: boolean;
  /** The author's work on it. */
  state: "waiting" | "preparing" | "ready" | "failed";
  error?: string;
  /** The question to read it for. */
  guide?: string;
  /** A key place to explain in one's own words. */
  explain?: { anchor: string; prompt: string };
  figures: { id: string; label: string; questions: string[]; message?: string }[];
  /** Tables whose results are hidden for a guess first. */
  predicts: { id: string; label: string; question: string; answer?: string }[];
  /** It reports an experiment: a QALMRI sheet. */
  qalmri: boolean;
  qalmriRef?: Partial<Record<ReaderQalmriKey, string>>;
  /** The key points and their evidence: shown once the recall was graded (or skipped). */
  points?: { text: string; anchor: string }[];
  /** No checkpoint questions (related work, conclusion): the author said why. */
  light?: string;
  items: ReaderItemView[];
  recall?: ReaderWriteView;
  explained?: ReaderWriteView;
  qalmriWrite?: ReaderWriteView;
  /** Its tasks the reader skipped ("recall", "explain", "qalmri"). */
  skipped: string[];
  score: ReaderScore;
  /** Its checkpoint is through (each step done or skipped). */
  done: boolean;
}

export interface ReaderConceptView {
  id: string;
  name: string;
  anchor?: string;
  /** 0–1, weighted by how high on Bloom's scale the answers were; absent with no answer yet. */
  mastery?: number;
  answers: number;
}

export interface ReaderAuthorView {
  state: "idle" | "running" | "stopped" | "failed";
  /** What it does now: "Bản đồ paper", "Checkpoint §4". */
  task?: string;
  note?: string;
  error?: string;
  queued: number;
}

/** Everything the passes need: the paper's map, the units with their checkpoints, what the reader wrote and answered. */
export interface ReaderGuide {
  paperId: string;
  goal?: ReaderGoal;
  pass: ReaderPass;
  /** Passes finished. */
  passed: ReaderPass[];
  author: ReaderAuthorView;
  map: {
    /** The parts written so far (the author writes them one by one). */
    has: Record<ReaderMapPart, boolean>;
    roles: { anchor: string; role: ReaderRole }[];
    concepts: ReaderConceptView[];
    notation: { symbol: string; meaning: string; shape?: string; anchor?: string }[];
    background: { name: string; why: string; explain: string; link?: string }[];
    pretest: ReaderPretestView[];
    /** The reference 5C: once the reader's own was graded, or skipped. */
    fivec?: Partial<Record<ReaderFiveC, string>>;
  };
  fivec?: ReaderWriteView;
  summary?: ReaderWriteView;
  units: ReaderUnitView[];
  /** The paper's misconception book. */
  misses: { concept: string; name: string; note: string; at: number; item?: string }[];
  /** Questions to answer again. */
  again: string[];
  score: ReaderScore;
  /** Pending tasks of passes 1–2 skipped ("5c", "summary", "pretest"). */
  skipped: string[];
}

export type ReaderMapPart = "roles" | "fivec" | "concepts" | "notation" | "background" | "pretest" | "units";

/** Points for an answer by how sure the reader was (Gardner-Medwin): 1 → +1/0, 2 → +2/−2, 3 → +3/−6. */
export function readerPoints(correct: boolean, confidence: 1 | 2 | 3): number {
  return correct ? confidence : ([0, 0, -2, -6] as const)[confidence];
}
