import ReactReconciler from 'react-reconciler'
import { hostConfig } from './host-config'
import type { LeaferRootContainer } from './types'
import type { App } from 'leafer-editor'
import type { ReactNode } from 'react'

const reconciler = ReactReconciler(hostConfig)

const roots = new WeakMap<App, any>()

export function render(element: ReactNode, app: App) {
  let container: LeaferRootContainer
  let root = roots.get(app)

  if (!root) {
    container = { app, children: [] }
    root = reconciler.createContainer(
      container,
      0, // LegacySyncRoot
      null,
      false,
      null,
      '',
      (err: Error) => console.error(err),
      (err: Error) => console.error(err),
      (err: Error) => console.error(err),
      () => {}
    )
    roots.set(app, root)
  }

  reconciler.updateContainer(element, root, null, () => {})
}

export function unmount(app: App) {
  const root = roots.get(app)
  if (root) {
    reconciler.updateContainer(null, root, null, () => {})
    roots.delete(app)
  }
}
