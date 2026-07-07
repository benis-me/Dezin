import { Fragment, type ReactNode } from "react";

/**
 * A compact, dependency-free syntax highlighter for the Files viewer. Not a full parser — a
 * single-pass tokenizer covering the tokens that carry the most signal in what Dezin generates
 * (HTML / CSS / JS / TS / JSX / JSON): comments, strings, numbers/hex-colors, keywords, HTML tags.
 * Falls back to plain text on any failure. No new dependency, no bundle weight.
 */
const TOKEN = new RegExp(
  [
    "(?<comment>//[^\\n]*|/\\*[\\s\\S]*?\\*/|<!--[\\s\\S]*?-->)",
    "(?<string>\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)",
    "(?<tag></?[a-zA-Z][\\w-]*)",
    "(?<keyword>\\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|do|import|export|from|as|default|class|extends|new|await|async|try|catch|finally|throw|typeof|instanceof|in|of|this|super|yield|delete|void|null|undefined|true|false)\\b)",
    "(?<number>#[0-9a-fA-F]{3,8}\\b|\\b\\d[\\d._]*(?:px|rem|em|vh|vw|%|s|ms)?\\b)",
  ].join("|"),
  "g",
);

const CLASS: Record<string, string> = {
  comment: "text-muted-foreground/60 italic",
  string: "text-emerald-600 dark:text-emerald-400",
  tag: "text-sky-600 dark:text-sky-400",
  keyword: "text-violet-600 dark:text-violet-400",
  number: "text-amber-600 dark:text-amber-400",
};
const TYPES = Object.keys(CLASS);

/** Tokenize `code` into React nodes with syntax colors. */
export function highlightToReact(code: string): ReactNode {
  try {
    const out: ReactNode[] = [];
    let last = 0;
    let key = 0;
    for (const m of code.matchAll(TOKEN)) {
      const idx = m.index ?? 0;
      if (idx > last) out.push(<Fragment key={key++}>{code.slice(last, idx)}</Fragment>);
      const type = TYPES.find((t) => m.groups?.[t] != null);
      out.push(
        type ? (
          <span key={key++} className={CLASS[type]}>
            {m[0]}
          </span>
        ) : (
          <Fragment key={key++}>{m[0]}</Fragment>
        ),
      );
      last = idx + m[0].length;
    }
    if (last < code.length) out.push(<Fragment key={key++}>{code.slice(last)}</Fragment>);
    return out;
  } catch {
    return code;
  }
}
