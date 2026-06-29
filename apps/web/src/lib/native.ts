/** Access to the Electron preload bridge (window.dezin), undefined in a plain browser. */

export interface DezinNative {
  isElectron: boolean;
  platform: string;
  pickFiles: () => Promise<string[]>;
  pickFolder: () => Promise<string[]>;
}

export const native: DezinNative | undefined =
  typeof window !== "undefined" ? (window as unknown as { dezin?: DezinNative }).dezin : undefined;
