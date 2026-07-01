/**
 * Register all built-in Leafer elements.
 * Imported for side effects — call once at startup.
 */
import {
  Rect,
  Ellipse,
  Star,
  Polygon,
  Line,
  Path,
  Pen,
  Text,
  Image,
  Group,
  Box,
  Frame,
} from 'leafer-editor'
import { Flow } from '@leafer-in/flow'
import { registerElement } from './element-registry'

registerElement('Rect', Rect as any)
registerElement('Ellipse', Ellipse as any)
registerElement('Star', Star as any)
registerElement('Polygon', Polygon as any)
registerElement('Line', Line as any)
registerElement('Path', Path as any)
registerElement('Pen', Pen as any)
registerElement('Text', Text as any)
registerElement('Image', Image as any)
registerElement('Group', Group as any)
registerElement('Box', Box as any)
registerElement('Frame', Frame as any)
registerElement('Flow', Flow as any)
