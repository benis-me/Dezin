import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { assertLazyEditorModulesStayLazy } from "../../scripts/bundle-module-policy.mjs";

/**
 * Portless dev: discover the daemon's URL from the discovery file the daemon
 * writes (DEZIN_PORTFILE, default <repo>/.dezin/daemon.json). Falls back to
 * DEZIN_PORT or 7457 if the file isn't there yet.
 */
type DaemonInfo = { url?: string; port?: number; token?: string };

function daemonInfo(): DaemonInfo {
  const portFile = process.env.DEZIN_PORTFILE ?? join(import.meta.dirname, "..", "..", ".dezin", "daemon.json");
  try {
    if (existsSync(portFile)) {
      return JSON.parse(readFileSync(portFile, "utf8")) as DaemonInfo;
    }
  } catch {
    // fall through to the default target
  }
  return {};
}

function daemonTarget(): string {
  const info = daemonInfo();
  if (info.url) return info.url;
  if (info.port) return `http://127.0.0.1:${info.port}`;
  return `http://127.0.0.1:${process.env.DEZIN_PORT ?? 7457}`;
}

function daemonToken(): string {
  return daemonInfo().token?.trim() ?? "";
}

function configureDaemonProxy(proxy: { on: Function }) {
  proxy.on("proxyReq", (proxyReq: { setHeader: Function }) => {
    const token = daemonToken();
    if (token) proxyReq.setHeader("x-dezin-daemon-token", token);
  });
}

const target = daemonTarget();
const require = createRequire(import.meta.url);
const nucleoFill18PackageDir = dirname(require.resolve("nucleo-ui-essential-fill-18/package.json"));
const nucleoFill18Runtime = join(nucleoFill18PackageDir, "dist", "min", "index.min.js");
// Dev server port. Override with DEZIN_WEB_PORT; defaults off the common 5173.
const webPort = Number(process.env.DEZIN_WEB_PORT ?? 6273);

// Mirror the daemon's portfile pattern for Vite's own port: once the server is
// listening, write the ACTUAL bound URL to .dezin/web.json so the desktop shell
// can find us even after an auto-fallback (strictPort off → next free port).
function webPortfilePlugin() {
  const file = join(import.meta.dirname, "..", "..", ".dezin", "web.json");
  const clean = () => {
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
  };
  return {
    name: "dezin-web-portfile",
    configureServer(server: { httpServer: { once: Function; address: Function } | null }) {
      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        const port = addr && typeof addr === "object" ? addr.port : webPort;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ url: `http://localhost:${port}`, port }));
      });
      server.httpServer?.once("close", clean);
      process.once("exit", clean);
    },
  };
}

function bundleModuleGuardPlugin(): Plugin {
  return {
    name: "dezin-bundle-module-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((item) => item.type === "chunk"
        ? [{
            file: item.fileName,
            isEntry: item.isEntry,
            imports: item.imports,
            modules: Object.keys(item.modules),
          }]
        : []);
      assertLazyEditorModulesStayLazy(chunks);
    },
  };
}
// Re-read the discovery file per request so a daemon restart (e.g. `node --watch`
// rebinding a new ephemeral port) is picked up without restarting Vite.
const router = () => daemonTarget();

export default defineConfig({
  plugins: [react(), tailwindcss(), webPortfilePlugin(), bundleModuleGuardPlugin()],
  resolve: {
    alias: {
      "@": join(import.meta.dirname, "src"),
      "nucleo-ui-essential-fill-18": nucleoFill18Runtime,
    },
    // pnpm can resolve a second React instance for radix-ui → "Invalid hook call".
    // Force a single copy of React across the app and component libs.
    dedupe: ["react", "react-dom"],
  },
  server: {
    // Off the common 5173. Start at webPort; if taken, Vite auto-falls-back to
    // the next free port. webPortfilePlugin records the actual port so the
    // desktop shell stays in sync (no strictPort needed).
    port: webPort,
    proxy: {
      "/api": { target, changeOrigin: true, router, configure: configureDaemonProxy },
      // Only the daemon's artifact-serving paths (/projects/:id/preview/*) go to the
      // daemon. Client routes like /projects/:id are SPA routes → serve index.html.
      "/projects": {
        target,
        changeOrigin: true,
        router,
        configure: configureDaemonProxy,
        bypass: (req) => (req.url && req.url.includes("/preview/") ? undefined : "/index.html"),
      },
    },
  },
  build: {
    manifest: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 61,
        branches: 59,
        functions: 59,
        lines: 64,
      },
    },
  },
});
