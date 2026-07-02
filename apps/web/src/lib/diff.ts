/** A minimal LCS-based line diff — enough to show what changed between two artifacts. */
export type DiffLine = { t: "ctx" | "add" | "del"; text: string };

const MAX_EXACT_LCS_CELLS = 1_000_000;

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  const out: DiffLine[] = [];

  let prefix = 0;
  while (prefix < m && prefix < n && a[prefix] === b[prefix]) {
    out.push({ t: "ctx", text: a[prefix]! });
    prefix++;
  }

  let endA = m - 1;
  let endB = n - 1;
  const suffix: DiffLine[] = [];
  while (endA >= prefix && endB >= prefix && a[endA] === b[endB]) {
    suffix.push({ t: "ctx", text: a[endA]! });
    endA--;
    endB--;
  }

  const midA = a.slice(prefix, endA + 1);
  const midB = b.slice(prefix, endB + 1);
  if (midA.length * midB.length > MAX_EXACT_LCS_CELLS) {
    for (const text of midA) out.push({ t: "del", text });
    for (const text of midB) out.push({ t: "add", text });
    out.push(...suffix.reverse());
    return out;
  }

  out.push(...diffLinesExact(midA, midB), ...suffix.reverse());
  return out;
}

function diffLinesExact(a: string[], b: string[]): DiffLine[] {
  const m = a.length;
  const n = b.length;
  // LCS length table (bottom-up).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ t: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ t: "del", text: a[i]! });
      i++;
    } else {
      out.push({ t: "add", text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ t: "del", text: a[i++]! });
  while (j < n) out.push({ t: "add", text: b[j++]! });
  return out;
}

export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.t === "add") added++;
    else if (l.t === "del") removed++;
  }
  return { added, removed };
}
