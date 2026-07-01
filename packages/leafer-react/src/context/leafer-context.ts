import { createContext } from 'react'
import type { App } from 'leafer-editor'

export const LeaferContext = createContext<App | null>(null)
