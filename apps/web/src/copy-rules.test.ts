import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * CONTRIBUTING: "User-facing copy uses no em dashes." This walks every
 * non-test source file and flags an em dash inside a string literal, template
 * literal, or JSX text. Comments and regular expressions are not copy and are
 * ignored by construction (they are different token kinds).
 */
const SRC = join(import.meta.dirname, ".");
const EM_DASH = "—";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "test" && entry !== "assets") out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.test\.|test-setup/.test(entry)) continue;
    out.push(path);
  }
  return out;
}

function copyNodesWithEmDash(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const isCopy = ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
      || ts.isJsxText(node);
    if (isCopy && node.getText(source).includes(EM_DASH)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      hits.push(`${relative(SRC, file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

test("user-facing copy contains no em dashes", () => {
  const offenders = sourceFiles(SRC).flatMap(copyNodesWithEmDash);
  expect(offenders).toEqual([]);
});
