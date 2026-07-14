export const FORBIDDEN_EAGER_MODULE = /(?:MoodboardCanvas|WorkspaceScreen|ProjectCanvas|(?:^|[\\/])@?leafer(?:[-+@\\/]|$)|(?:^|[\\/])@?xyflow(?:[+@\\/]|$))/i;

function dependencyClosure(chunks, roots) {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of byFile.get(file)?.imports ?? []) visit(dependency);
  };
  for (const root of roots) visit(root.file);
  return [...seen].map((file) => byFile.get(file)).filter(Boolean);
}

export function assertLazyEditorModulesStayLazy(chunks) {
  const guardedGraphs = [
    { label: "HomeScreen", roots: chunks.filter((chunk) => chunk.isEntry) },
    {
      label: "SettingsScreen",
      roots: chunks.filter((chunk) => chunk.modules.some((moduleId) => /(?:^|[\\/])SettingsScreen\.tsx(?:$|\?)/.test(moduleId))),
    },
  ];
  if (guardedGraphs[0].roots.length === 0) throw new Error("Bundle module graph has no initial entry");

  for (const { label, roots } of guardedGraphs) {
    const forbidden = dependencyClosure(chunks, roots)
      .flatMap((chunk) => chunk.modules)
      .find((moduleId) => FORBIDDEN_EAGER_MODULE.test(moduleId));
    if (forbidden) throw new Error(`${label} initial graph contains lazy editor/canvas module ${forbidden}`);
  }
}
