// Line diff for showing cell changes. Cells are small, so a plain LCS table is
// fine; very large inputs fall back to "replace everything".

export type DiffLine = { op: "eq" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // Trim common prefix and suffix so the table only covers the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ op: "eq", text: a[i]!, oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_CELLS) {
    midA.forEach((t, i) => out.push({ op: "del", text: t, oldNo: start + i + 1 }));
    midB.forEach((t, j) => out.push({ op: "add", text: t, newNo: start + j + 1 }));
  } else {
    // lcs[i][j] = LCS length of midA[i..] and midB[j..]
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ op: "eq", text: midA[i]!, oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
        // Deletions first on ties, the conventional order for a changed line.
        out.push({ op: "del", text: midA[i]!, oldNo: start + i + 1 });
        i++;
      } else {
        out.push({ op: "add", text: midB[j]!, newNo: start + j + 1 });
        j++;
      }
    }
  }

  const shift = b.length - a.length;
  for (let i = endA; i < a.length; i++) out.push({ op: "eq", text: a[i]!, oldNo: i + 1, newNo: i + 1 + shift });
  return out;
}

export type DiffRow = DiffLine | { op: "skip"; count: number };

/** Collapse long runs of unchanged lines, keeping `context` lines around each change. */
export function withContext(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.op === "eq") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) rows.push({ op: "skip", count: skipped });
      skipped = 0;
      rows.push(l);
    } else skipped++;
  });
  if (skipped) rows.push({ op: "skip", count: skipped });
  return rows;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "del") removed++;
  }
  return { added, removed };
}
