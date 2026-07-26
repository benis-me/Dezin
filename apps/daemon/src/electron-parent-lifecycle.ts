export interface ElectronParentProcess {
  readonly connected?: boolean;
  readonly send?: unknown;
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

export function watchElectronParent(input: {
  enabled: boolean;
  parent: ElectronParentProcess;
  shutdown: (reason: string) => void;
}): () => void {
  if (!input.enabled || typeof input.parent.send !== "function") return () => {};

  let active = true;
  const disconnect = (): void => {
    if (!active) return;
    active = false;
    input.shutdown("Electron parent disconnected");
  };

  if (input.parent.connected === false) {
    disconnect();
    return () => {};
  }

  input.parent.once("disconnect", disconnect);
  return () => {
    if (!active) return;
    active = false;
    input.parent.off("disconnect", disconnect);
  };
}
