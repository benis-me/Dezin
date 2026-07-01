import { useContext } from 'react'
import { LeaferContext } from '../context/leafer-context'
import type { App } from 'leafer-editor'

export function useLeafer(): App {
  const app = useContext(LeaferContext)
  if (!app) {
    throw new Error('useLeafer must be used within a <Leafer> component')
  }
  return app
}
