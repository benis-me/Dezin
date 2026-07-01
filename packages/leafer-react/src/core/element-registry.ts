import type { UI } from 'leafer-editor'

const registry = new Map<string, new (props?: any) => UI>()

export function registerElement(tag: string, ctor: new (props?: any) => UI) {
  registry.set(tag, ctor)
}

export function getElement(tag: string): new (props?: any) => UI {
  const ctor = registry.get(tag)
  if (!ctor) throw new Error(`Unknown leafer element: <${tag}>. Register it with registerElement().`)
  return ctor
}

export function registerComponent(
  tag: string,
  ElementClass: new (props?: any) => UI
) {
  registerElement(tag, ElementClass)
}
