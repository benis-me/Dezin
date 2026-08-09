import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WebPortfilePluginOptions {
  file: string;
  fallbackPort: number;
}

interface WebPortfileHttpServer {
  once(event: "listening" | "close", listener: () => void): unknown;
  address(): string | { port: number } | null;
}

export function webPortfilePlugin({ file, fallbackPort }: WebPortfilePluginOptions) {
  let ownedPayload: string | null = null;
  let trackingProcessExit = false;
  const cleanOwnedFile = () => {
    if (ownedPayload === null) return;
    try {
      if (readFileSync(file, "utf8") === ownedPayload) rmSync(file, { force: true });
    } catch {
      /* The file is already gone or unreadable. */
    }
    ownedPayload = null;
  };
  const onProcessExit = () => cleanOwnedFile();
  const stopTrackingProcessExit = () => {
    if (!trackingProcessExit) return;
    process.removeListener("exit", onProcessExit);
    trackingProcessExit = false;
  };
  return {
    name: "dezin-web-portfile",
    configureServer(server: { httpServer: WebPortfileHttpServer | null }) {
      const httpServer = server.httpServer;
      if (!httpServer) return;
      httpServer.once("listening", () => {
        const addr = httpServer.address();
        const port = addr && typeof addr === "object" ? addr.port : fallbackPort;
        const payload = JSON.stringify({ url: `http://localhost:${port}`, port });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, payload);
        ownedPayload = payload;
        if (!trackingProcessExit) {
          process.once("exit", onProcessExit);
          trackingProcessExit = true;
        }
      });
      httpServer.once("close", () => {
        cleanOwnedFile();
        stopTrackingProcessExit();
      });
    },
  };
}
