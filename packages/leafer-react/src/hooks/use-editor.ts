import { useLeafer } from './use-leafer'
import type { IEditorBase, IUI } from 'leafer-editor'

export interface EditorControls {
  select: (ids: string | string[]) => void
  clear: () => void
  getSelected: () => any[]
  getEditor: () => IEditorBase | null
}

export function useEditor(): EditorControls {
  const app = useLeafer()
  const editor = app.editor

  return {
    select(ids: string | string[]) {
      if (!editor) return
      const idList = Array.isArray(ids) ? ids : [ids]
      const targets = idList
        .map((id) => app.tree.findOne('#' + id))
        .filter((target): target is IUI => Boolean(target))
      if (targets.length) {
        editor.target = targets.length === 1 ? targets[0] : targets
      }
    },
    clear() {
      if (editor) editor.target = undefined
    },
    getSelected() {
      if (!editor?.target) return []
      return Array.isArray(editor.target) ? editor.target : [editor.target]
    },
    getEditor() {
      return editor ?? null
    },
  }
}
