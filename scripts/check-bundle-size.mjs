import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_EAGER_MODULE } from "./bundle-module-policy.mjs";

const KIB = 1024;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_BUNDLE_BUDGETS = {
  maxInitialMinified: 500 * KIB,
  maxInitialGzip: 180 * KIB,
  // 2026-07-22 multi-artifact Studio initial closure. ProjectStudio, Canvas,
  // Resource/Research viewers, Versions, and Flow remain outside Home/Settings.
  initialJsGzipBaseline: 324_676,
  // 2026-07-22 multi-artifact Studio baseline: versioned Resource/Research
  // viewers, Artifact Versions, and prototype Flow. Studio, Canvas, and Flow
  // remain outside the Home/Settings dependency closures.
  totalJsGzipBaseline: 931_282,
};

async function filesUnder(root) {
  const output = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await walk(root);
  return output;
}

function dependencyClosure(manifest, roots) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dependency of manifest[key]?.imports ?? []) visit(dependency);
  };
  for (const root of roots) visit(root);
  return seen;
}

function formatKiB(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

export async function checkBundle({ distDir = join(REPO_ROOT, "apps", "web", "dist"), budgets = {} } = {}) {
  const limits = { ...DEFAULT_BUNDLE_BUDGETS, ...budgets };
  const manifestPath = join(distDir, ".vite", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entryKeys = Object.entries(manifest).filter(([, value]) => value.isEntry).map(([key]) => key);
  if (!entryKeys.length) throw new Error("Bundle manifest has no initial entry");

  const initialKeys = dependencyClosure(manifest, entryKeys);
  const initialFiles = new Set(
    [...initialKeys].map((key) => manifest[key]?.file).filter((file) => typeof file === "string" && file.endsWith(".js")),
  );
  const allJsPaths = (await filesUnder(distDir)).filter((path) => path.endsWith(".js"));
  const chunks = [];
  for (const path of allJsPaths) {
    const body = await readFile(path);
    const file = relative(distDir, path);
    chunks.push({ file, minified: body.byteLength, gzip: gzipSync(body).byteLength, initial: initialFiles.has(file) });
  }

  for (const chunk of chunks.filter((item) => item.initial)) {
    if (chunk.minified > limits.maxInitialMinified) {
      throw new Error(
        `Initial chunk ${chunk.file} is ${formatKiB(chunk.minified)}; limit is ${formatKiB(limits.maxInitialMinified)} minified`,
      );
    }
    if (chunk.gzip > limits.maxInitialGzip) {
      throw new Error(
        `Initial chunk ${chunk.file} is ${formatKiB(chunk.gzip)}; limit is ${formatKiB(limits.maxInitialGzip)} gzip`,
      );
    }
  }

  const initialGzip = chunks
    .filter((chunk) => chunk.initial)
    .reduce((total, chunk) => total + chunk.gzip, 0);
  const initialLimit = Math.ceil(limits.initialJsGzipBaseline * 1.05);
  if (initialGzip > initialLimit) {
    throw new Error(
      `Initial JS gzip is ${formatKiB(initialGzip)}; baseline + 5% is ${formatKiB(initialLimit)} (baseline ${formatKiB(limits.initialJsGzipBaseline)})`,
    );
  }

  const totalGzip = chunks.reduce((total, chunk) => total + chunk.gzip, 0);
  const totalLimit = Math.ceil(limits.totalJsGzipBaseline * 1.05);
  if (totalGzip > totalLimit) {
    throw new Error(
      `Total JS gzip is ${formatKiB(totalGzip)}; baseline + 5% is ${formatKiB(totalLimit)} (baseline ${formatKiB(limits.totalJsGzipBaseline)})`,
    );
  }

  const guardedGraphs = [
    { label: "HomeScreen", roots: entryKeys },
    ...Object.keys(manifest)
      .filter((key) => /(?:^|\/)SettingsScreen\.tsx$/.test(key))
      .map((key) => ({ label: "SettingsScreen", roots: [key] })),
  ];
  for (const { label, roots } of guardedGraphs) {
    const graph = dependencyClosure(manifest, roots);
    const forbidden = [...graph].find(
      (key) => !roots.includes(key) && FORBIDDEN_EAGER_MODULE.test(key),
    );
    if (forbidden) throw new Error(`${label} initial graph imports lazy editor/canvas module ${forbidden}`);
  }

  return {
    initialGzip,
    initialLimit,
    totalGzip,
    totalLimit,
    initialChunks: chunks.filter((chunk) => chunk.initial),
    lazyChunks: chunks.filter((chunk) => !chunk.initial),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  checkBundle({ distDir: process.argv[2] ? resolve(process.argv[2]) : undefined })
    .then((report) => {
      for (const chunk of report.initialChunks) {
        process.stdout.write(`initial ${chunk.file}: ${formatKiB(chunk.minified)} min / ${formatKiB(chunk.gzip)} gzip\n`);
      }
      for (const chunk of report.lazyChunks) {
        process.stdout.write(`lazy    ${chunk.file}: ${formatKiB(chunk.minified)} min / ${formatKiB(chunk.gzip)} gzip\n`);
      }
      process.stdout.write(`initial JS gzip: ${formatKiB(report.initialGzip)} / ${formatKiB(report.initialLimit)}\n`);
      process.stdout.write(`total JS gzip: ${formatKiB(report.totalGzip)} / ${formatKiB(report.totalLimit)}\nBUNDLE: PASS\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
