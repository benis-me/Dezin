import type { App, IEditorBase, IUI } from "leafer-editor";

export type EditorSelectionTarget = IUI | IUI[] | undefined;

export function getEditorSelection(editor?: IEditorBase | null) {
  return editor?.target as EditorSelectionTarget;
}

export function setEditorSelection(editor: IEditorBase | null | undefined, target: EditorSelectionTarget) {
  if (!editor) return;
  editor.target = target;
}

export function clearEditorSelection(editor?: IEditorBase | null) {
  setEditorSelection(editor, undefined);
}

export function selectAppNodesByIds(app: App | null | undefined, nodeIds: readonly string[]) {
  if (!app?.editor || nodeIds.length === 0) {
    const editor = app?.editor as (IEditorBase & { select?: (target: IUI[]) => void }) | null | undefined;
    if (typeof editor?.select === "function") editor.select([]);
    clearEditorSelection(editor);
    return;
  }

  const selectedNodes = nodeIds.map((id) => app.findId(id)).filter((node): node is IUI => Boolean(node));

  const editor = app.editor as IEditorBase & { select?: (target: IUI[]) => void };
  if (typeof editor.select === "function") editor.select(selectedNodes);
  setEditorSelection(editor, selectedNodes.length === 1 ? selectedNodes[0] : selectedNodes.length > 1 ? selectedNodes : undefined);
}
