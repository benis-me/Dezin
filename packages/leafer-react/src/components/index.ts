import { defineLeaferElement } from './factory'

// ── Layout containers ──
export const Frame = defineLeaferElement('Frame')
export const Group = defineLeaferElement('Group')
export const Box = defineLeaferElement('Box')
export const Flow = defineLeaferElement('Flow')

// ── Shapes ──
export const Rect = defineLeaferElement('Rect')
export const Ellipse = defineLeaferElement('Ellipse')
export const Star = defineLeaferElement('Star')
export const Polygon = defineLeaferElement('Polygon')
export const Line = defineLeaferElement('Line')
export const Path = defineLeaferElement('Path')
export const Pen = defineLeaferElement('Pen', {
  transform: (props: any) => {
    const { path, ...rest } = props
    if (path) return { tag: 'Path', props: { ...rest, path } }
    return rest
  },
})

// ── Content ──
// Img / Txt avoid conflict with DOM's Image / Text globals
export const Img = defineLeaferElement('Image')
export const Txt = defineLeaferElement('Text', {
  transform: (props: any) => ({
    ...props,
    text: props.text ?? props.children,
  }),
})

// ── Backward-compat aliases (will remove later) ──
export const LImage = Img
export const LText = Txt

export { Leafer } from './leafer'
export { defineLeaferElement } from './factory'
