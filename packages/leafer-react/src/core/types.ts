import type { App } from 'leafer-editor'

export interface LeaferHostInstance {
  instance: any // Leafer UI element or { __text: string }
  type: string
  props: Record<string, any>
}

export interface LeaferRootContainer {
  app: App
  children: LeaferHostInstance[]
}
