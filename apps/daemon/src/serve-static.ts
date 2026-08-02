import { join } from "node:path";

export function projectDir(dataDir: string, projectId: string): string {
  return join(dataDir, "projects", projectId);
}
