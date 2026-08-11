import { putLocalFigmaCredential } from "../../src/design/figma-credential-store.ts";

const dataDir = process.argv[2];
const token = process.argv[3];
const mode = process.argv[4] ?? "crash";
if (!dataDir || !token) throw new Error("dataDir and token are required");

let releasePending!: () => void;
const pendingRelease = new Promise<void>((resolve) => { releasePending = resolve; });
process.on("message", (message) => {
  if (message === "release") releasePending();
});

const status = await putLocalFigmaCredential({
  dataDir,
  token,
  env: {},
  testHooks: {
    afterCredentialPendingSync: async () => {
      if (mode === "crash") process.exit(93);
      if (mode !== "pause") throw new Error(`unknown worker mode: ${mode}`);
      process.send?.({ type: "pending" });
      await pendingRelease;
    },
  },
});

if (mode === "pause") {
  await new Promise<void>((resolve, reject) => {
    process.send?.({ type: "result", status }, (error) => error ? reject(error) : resolve());
  });
  process.disconnect?.();
}
