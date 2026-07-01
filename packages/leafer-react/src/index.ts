// Register built-in elements (side-effect import)
import './core/leafer-elements'

// Components
export {
  Leafer,
  // Containers
  Frame,
  Group,
  Box,
  Flow,
  // Shapes
  Rect,
  Ellipse,
  Star,
  Polygon,
  Line,
  Path,
  Pen,
  // Content
  Img,
  Txt,
  // Backward-compat aliases
  LText,
  LImage,
  // Factory
  defineLeaferElement,
} from './components'

// Hooks
export { useLeafer } from './hooks/use-leafer'
export { useEditor } from './hooks/use-editor'

// Context
export { LeaferContext } from './context/leafer-context'

// Reconciler
export { render, unmount } from './core/renderer'

// Element registry
export { registerElement, registerComponent } from './core/element-registry'

// Built-in performance plugins
export { ViewportLighter, type ViewportLighterOptions } from './plugins/viewport-lighter'
export {
  ImageLighter,
  isImageLighterLoading,
  type ImageLighterOptions,
} from './plugins/image-lighter'
