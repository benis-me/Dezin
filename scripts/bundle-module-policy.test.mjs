import assert from "node:assert/strict";
import test from "node:test";
import { assertLazyEditorModulesStayLazy } from "./bundle-module-policy.mjs";

test("bundle module policy allows editor code only behind dynamic imports", () => {
  assert.doesNotThrow(() => assertLazyEditorModulesStayLazy([
    { file: "assets/index.js", isEntry: true, imports: [], modules: ["src/main.tsx"] },
    {
      file: "assets/settings.js",
      isEntry: false,
      imports: ["assets/index.js"],
      modules: ["src/screens/SettingsScreen.tsx"],
    },
    {
      file: "assets/workspace.js",
      isEntry: false,
      imports: ["assets/index.js"],
      modules: ["src/screens/WorkspaceScreen.tsx"],
    },
  ]));
});

test("bundle module policy catches editor source folded into an initial chunk", () => {
  assert.throws(
    () => assertLazyEditorModulesStayLazy([
      {
        file: "assets/index.js",
        isEntry: true,
        imports: [],
        modules: ["src/main.tsx", "src/screens/WorkspaceScreen.tsx"],
      },
    ]),
    /HomeScreen.*contains.*WorkspaceScreen/i,
  );
});

test("bundle module policy follows static chunk imports and guards Settings", () => {
  assert.throws(
    () => assertLazyEditorModulesStayLazy([
      { file: "assets/index.js", isEntry: true, imports: [], modules: ["src/main.tsx"] },
      {
        file: "assets/settings.js",
        isEntry: false,
        imports: ["assets/settings-vendor.js"],
        modules: ["src/screens/SettingsScreen.tsx"],
      },
      {
        file: "assets/settings-vendor.js",
        isEntry: false,
        imports: [],
        modules: ["node_modules/.pnpm/@leafer+core/index.js"],
      },
    ]),
    /SettingsScreen.*leafer/i,
  );
});

test("bundle module policy keeps React Flow outside Home and Settings dependency closures", () => {
  const graph = [
    { file: "assets/index.js", isEntry: true, imports: ["assets/vendor.js"], modules: ["src/main.tsx"] },
    { file: "assets/vendor.js", isEntry: false, imports: [], modules: ["node_modules/.pnpm/@xyflow+react/index.js"] },
    { file: "assets/settings.js", isEntry: false, imports: [], modules: ["src/screens/SettingsScreen.tsx"] },
  ];
  assert.throws(() => assertLazyEditorModulesStayLazy(graph), /HomeScreen.*xyflow/i);

  graph[0] = { file: "assets/index.js", isEntry: true, imports: [], modules: ["src/main.tsx"] };
  graph[2] = {
    file: "assets/settings.js",
    isEntry: false,
    imports: ["assets/vendor.js"],
    modules: ["src/screens/SettingsScreen.tsx"],
  };
  assert.throws(() => assertLazyEditorModulesStayLazy(graph), /SettingsScreen.*xyflow/i);
});

test("bundle module policy keeps every Project Studio capability outside Home and Settings", () => {
  for (const moduleId of [
    "src/project-studio/ProjectStudioScreen.tsx",
    "src/project-studio/resource/ResourceEditorSurface.tsx",
    "src/project-studio/research/ResearchResourceViewer.tsx",
    "src/project-studio/flow/PrototypeFlowViewer.tsx",
    "src/project-studio/artifact/ArtifactVersions.tsx",
  ]) {
    assert.throws(
      () => assertLazyEditorModulesStayLazy([
        {
          file: "assets/index.js",
          isEntry: true,
          imports: [],
          modules: ["src/main.tsx", moduleId],
        },
      ]),
      /HomeScreen.*project-studio/i,
    );

    assert.throws(
      () => assertLazyEditorModulesStayLazy([
        { file: "assets/index.js", isEntry: true, imports: [], modules: ["src/main.tsx"] },
        {
          file: "assets/settings.js",
          isEntry: false,
          imports: [],
          modules: ["src/screens/SettingsScreen.tsx", moduleId],
        },
      ]),
      /SettingsScreen.*project-studio/i,
    );
  }
});
