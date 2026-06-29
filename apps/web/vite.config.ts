import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Portless dev: discover the daemon's URL from the discovery file the daemon
 * writes (DEZIN_PORTFILE, default <repo>/.dezin/daemon.json). Falls back to
 * DEZIN_PORT or 7457 if the file isn't there yet.
 */
function daemonTarget(): string {
  const portFile = process.env.DEZIN_PORTFILE ?? join(import.meta.dirname, "..", "..", ".dezin", "daemon.json");
  try {
    if (existsSync(portFile)) {
      const info = JSON.parse(readFileSync(portFile, "utf8")) as { url?: string; port?: number };
      if (info.url) return info.url;
      if (info.port) return `http://127.0.0.1:${info.port}`;
    }
  } catch {
    // fall through to the default
  }
  return `http://127.0.0.1:${process.env.DEZIN_PORT ?? 7457}`;
}

const target = daemonTarget();
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
// Re-read the discovery file per request so a daemon restart (e.g. `node --watch`
// rebinding a new ephemeral port) is picked up without restarting Vite.
const router = () => daemonTarget();

export default defineConfig({
  plugins: [react(), tailwindcss(), webPortfilePlugin()],
  resolve: {
    alias: { "@": join(import.meta.dirname, "src") },
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
      "/api": { target, changeOrigin: true, router },
      // Only the daemon's artifact-serving paths (/projects/:id/preview/*) go to the
      // daemon. Client routes like /projects/:id are SPA routes → serve index.html.
      "/projects": {
        target,
        changeOrigin: true,
        router,
        bypass: (req) => (req.url && req.url.includes("/preview/") ? undefined : "/index.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
