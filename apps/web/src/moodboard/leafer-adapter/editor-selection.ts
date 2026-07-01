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
    clearEditorSelection(app?.editor);
    return;
  }

  const selectedNodes = nodeIds.map((id) => app.findId(id)).filter((node): node is IUI => Boolean(node));

  setEditorSelection(app.editor, selectedNodes.length === 1 ? selectedNodes[0] : selectedNodes.length > 1 ? selectedNodes : undefined);
}
