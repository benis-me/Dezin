import { createHighlighter } from "@tanstack/highlight/core";
import { css } from "@tanstack/highlight/languages/css";
import { diff } from "@tanstack/highlight/languages/diff";
import { dockerfile } from "@tanstack/highlight/languages/dockerfile";
import { env } from "@tanstack/highlight/languages/env";
import { html } from "@tanstack/highlight/languages/html";
import { js } from "@tanstack/highlight/languages/js";
import { json } from "@tanstack/highlight/languages/json";
import { jsx } from "@tanstack/highlight/languages/jsx";
import { plaintext } from "@tanstack/highlight/languages/plaintext";
import { python } from "@tanstack/highlight/languages/python";
import { shell } from "@tanstack/highlight/languages/shell";
import { sql } from "@tanstack/highlight/languages/sql";
import { svelte } from "@tanstack/highlight/languages/svelte";
import { toml } from "@tanstack/highlight/languages/toml";
import { ts } from "@tanstack/highlight/languages/ts";
import { tsx } from "@tanstack/highlight/languages/tsx";
import { vue } from "@tanstack/highlight/languages/vue";
import { yaml } from "@tanstack/highlight/languages/yaml";

export type TypedMaterialPresentation =
  | { kind: "markdown"; language: "markdown" }
  | { kind: "code"; language: string }
  | { kind: "text"; language: "plaintext" }
  | { kind: "binary"; language: null };

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ".bash": "shell",
  ".cjs": "js",
  ".css": "css",
  ".cts": "ts",
  ".diff": "diff",
  ".env": "env",
  ".htm": "html",
  ".html": "html",
  ".js": "js",
  ".json": "json",
  ".jsonc": "json",
  ".jsx": "jsx",
  ".mjs": "js",
  ".mts": "ts",
  ".patch": "diff",
  ".py": "python",
  ".sh": "shell",
  ".sql": "sql",
  ".svelte": "svelte",
  ".toml": "toml",
  ".ts": "ts",
  ".tsx": "tsx",
  ".vue": "vue",
  ".xhtml": "html",
  ".xml": "html",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "shell",
};

const PLAINTEXT_SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".clj", ".cljs", ".conf", ".cpp", ".cs", ".dart", ".ex", ".exs",
  ".fs", ".fsx", ".go", ".gradle", ".graphql", ".h", ".hpp", ".ini", ".java",
  ".kt", ".kts", ".less", ".lua", ".m", ".mm", ".php", ".proto", ".r", ".rb",
  ".rs", ".sass", ".scala", ".scss", ".sol", ".swift",
]);

const TEXT_EXTENSIONS = new Set([".csv", ".log", ".text", ".txt"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdown", ".markdown", ".mdx"]);
const SOURCE_BASENAMES = new Set(["dockerfile", "gemfile", "makefile", "procfile"]);

const MIME_LANGUAGES: Readonly<Record<string, string>> = {
  "application/ecmascript": "js",
  "application/javascript": "js",
  "application/json": "json",
  "application/ld+json": "json",
  "application/sql": "sql",
  "application/typescript": "ts",
  "application/x-httpd-php": "plaintext",
  "application/x-javascript": "js",
  "application/x-sh": "shell",
  "application/xhtml+xml": "html",
  "application/xml": "html",
  "image/svg+xml": "html",
  "text/css": "css",
  "text/csv": "plaintext",
  "text/ecmascript": "js",
  "text/html": "html",
  "text/javascript": "js",
  "text/jsx": "jsx",
  "text/python": "python",
  "text/sql": "sql",
  "text/typescript": "ts",
  "text/tsx": "tsx",
  "text/x-python": "python",
  "text/x-shellscript": "shell",
  "text/xml": "html",
  "text/yaml": "yaml",
};

export const typedMaterialHighlighter = createHighlighter({
  fallbackLanguage: "plaintext",
  languages: [
    plaintext,
    css,
    diff,
    dockerfile,
    env,
    html,
    js,
    json,
    jsx,
    python,
    shell,
    sql,
    svelte,
    toml,
    ts,
    tsx,
    vue,
    yaml,
  ],
});

function normalizedMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

export function fileExtension(fileName: string | null | undefined): string {
  const name = (fileName ?? "").trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function typedMaterialPresentation(
  fileName: string | null | undefined,
  mimeType: string | null | undefined,
): TypedMaterialPresentation {
  const normalizedName = (fileName ?? "").trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  const extension = fileExtension(normalizedName);
  const mime = normalizedMimeType(mimeType);

  if (MARKDOWN_EXTENSIONS.has(extension) || mime === "text/markdown" || mime === "text/x-markdown") {
    return { kind: "markdown", language: "markdown" };
  }

  const extensionLanguage = EXTENSION_LANGUAGES[extension];
  if (extensionLanguage) return { kind: "code", language: extensionLanguage };
  if (normalizedName === "dockerfile" || normalizedName.startsWith("dockerfile.")) {
    return { kind: "code", language: "dockerfile" };
  }
  if (SOURCE_BASENAMES.has(normalizedName) || PLAINTEXT_SOURCE_EXTENSIONS.has(extension)) {
    return { kind: "code", language: "plaintext" };
  }

  const mimeLanguage = MIME_LANGUAGES[mime];
  if (mimeLanguage) return { kind: "code", language: mimeLanguage };
  if (TEXT_EXTENSIONS.has(extension) || mime.startsWith("text/")) {
    return { kind: "text", language: "plaintext" };
  }
  return { kind: "binary", language: null };
}

export function displayLanguage(presentation: TypedMaterialPresentation): string {
  if (presentation.kind === "markdown") return "Markdown";
  if (presentation.kind === "text") return "Text";
  if (presentation.kind === "binary") return "File";
  const labels: Readonly<Record<string, string>> = {
    css: "CSS",
    diff: "Diff",
    dockerfile: "Dockerfile",
    env: "Environment",
    html: "HTML",
    js: "JavaScript",
    json: "JSON",
    jsx: "JSX",
    plaintext: "Source",
    python: "Python",
    shell: "Shell",
    sql: "SQL",
    svelte: "Svelte",
    toml: "TOML",
    ts: "TypeScript",
    tsx: "TSX",
    vue: "Vue",
    yaml: "YAML",
  };
  return labels[presentation.language] ?? presentation.language.toLocaleUpperCase();
}
