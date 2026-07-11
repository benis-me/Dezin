export interface BundleModuleChunk {
  file: string;
  isEntry: boolean;
  imports: string[];
  modules: string[];
}

export const FORBIDDEN_EAGER_MODULE: RegExp;
export function assertLazyEditorModulesStayLazy(chunks: BundleModuleChunk[]): void;
