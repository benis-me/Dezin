/**
 * Render lint findings into the `<artifact-lint>` system-reminder block that gets
 * fed back to the agent for self-correction.
 *
 * This is the message the closed loop injects as the next turn, giving the agent a
 * concrete list of findings to act on.
 */

import type { Finding } from "./types.ts";

function countBy(findings: Finding[], sev: string): number {
  return findings.filter((f) => f.severity === sev).length;
}

/**
 * Returns the `<artifact-lint>` block, or null when there is nothing to report.
 * P0 findings are listed first unless the caller requests an unranked block.
 */
export function renderFindingsForAgent(findings: Finding[], options: { unranked?: boolean } = {}): string | null {
  if (findings.length === 0) return null;

  const p0 = countBy(findings, "P0");
  const p1 = countBy(findings, "P1");
  const p2 = countBy(findings, "P2");

  const lines: string[] = [];
  lines.push("<artifact-lint>");
  if (options.unranked) {
    lines.push("The artifact you just produced has required source-fidelity findings. Fix every listed finding before stopping.");
  } else {
    lines.push(
      `The artifact you just produced has anti-slop / design-token issues: ` +
        `${p0} P0 (must fix), ${p1} P1 (should fix), ${p2} P2 (nice to have).`,
    );
  }
  lines.push("");
  for (const f of findings) {
    lines.push(options.unranked ? `**${f.id}** — ${f.message}` : `**[${f.severity}] ${f.id}** — ${f.message}`);
    if (f.selector) lines.push(`Target element: \`${f.selector}\` — change exactly this element.`);
    lines.push(`Fix: ${f.fix}`);
    if (f.snippet) lines.push(`Snippet: ${truncate(f.snippet, 160)}`);
    lines.push("");
  }
  lines.push(
    options.unranked
      ? "Re-write the artifact file to fix every finding, then stop. Do not explain — just emit the corrected file."
      : "Re-write the artifact file to fix every P0 (and ideally P1), then stop. Do not explain — just emit the corrected file.",
  );
  lines.push("</artifact-lint>");
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
