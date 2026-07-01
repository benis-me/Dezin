import assert from 'node:assert/strict'
import test from 'node:test'
import { ImageLighter, isImageLighterLoading } from './image-lighter.ts'

function createEventTarget() {
  const handlers = new Map<string, Array<(event?: any) => void>>()
  return {
    on(type: string, handler: (event?: any) => void) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
    },
    off(type: string, handler: (event?: any) => void) {
      const list = handlers.get(type) ?? []
      handlers.set(
        type,
        list.filter((item) => item !== handler)
      )
    },
    emit(type: string, event?: any) {
      handlers.get(type)?.forEach((handler) => handler(event))
    },
  }
}

function createImage(options: {
  url?: string
  x?: number
  y?: number
  width?: number
  height?: number
  naturalWidth?: number
  naturalHeight?: number
  ready?: boolean
}) {
  const events = createEventTarget()
  const image: any = {
    __tag: 'Image',
    url: options.url ?? 'https://img.test/a.png?imageMogr2/format/webp',
    fill: {
      type: 'image',
      mode: 'stretch',
      url: options.url ?? 'https://img.test/a.png?imageMogr2/format/webp',
    },
    x: options.x ?? 0,
    y: options.y ?? 0,
    width: options.width ?? 300,
    height: options.height ?? 200,
    ready: options.ready ?? true,
    image: {
      ready: options.ready ?? true,
      width: options.naturalWidth ?? 4000,
      height: options.naturalHeight ?? 3000,
    },
    getBounds() {
      return {
        x: this.x,
        y: this.y,
        width: this.width,
        height: this.height,
      }
    },
    on: events.on,
    off: events.off,
    emit: events.emit,
  }
  return image
}

function createTree(images: any[]) {
  const handlers = new Map<string, Array<(event?: any) => void>>()
  const tree: any = {
    children: images,
    zoomLayer: {
      __: { scaleX: 1, scaleY: 1 },
    },
    canvas: {
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
    },
    find(selector: string) {
      return selector === 'Image' ? images : []
    },
    on_(defs: Array<[string | string[], (event?: any) => void, unknown]>) {
      const ids: string[] = []
      for (const [types, fn, ctx] of defs) {
        for (const type of Array.isArray(types) ? types : [types]) {
          const bound = fn.bind(ctx)
          const list = handlers.get(type) ?? []
          list.push(bound)
          handlers.set(type, list)
          ids.push(type)
        }
      }
      return ids
    },
    off_(ids: string[]) {
      for (const id of ids) handlers.delete(id)
    },
    emit(type: string, event?: any) {
      handlers.get(type)?.forEach((handler) => handler(event))
    },
    handlerCount() {
      return handlers.size
    },
  }
  return tree
}

async function waitUpdate() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('ImageLighter installs with one constructor call without reloading displayed images', async () => {
  const image = createImage({})
  const originalFill = image.fill
  const tree = createTree([image])

  const lighter = new ImageLighter(tree, { updateDelay: 0 })
  await waitUpdate()

  assert.equal(image.fill, originalFill)

  lighter.destroy()
  assert.equal(image.fill, originalFill)
  assert.equal(tree.handlerCount(), 0)
})

test('ImageLighter keeps already displayed images stable during viewport zoom', async () => {
  const image = createImage({})
  const originalFill = image.fill
  const tree = createTree([image])
  const lighter = new ImageLighter(tree, { updateDelay: 0 })
  await waitUpdate()

  tree.zoomLayer.__ = { scaleX: 2, scaleY: 2 }
  tree.emit('zoom.end')
  await waitUpdate()

  assert.equal(image.fill, originalFill)
  lighter.destroy()
})

test('ImageLighter can opt in to loaded-image LOD switching', async () => {
  const image = createImage({})
  const tree = createTree([image])

  const lighter = new ImageLighter(tree, {
    updateDelay: 0,
    switchLoadedImages: true,
  })
  await waitUpdate()

  assert.equal(
    image.fill.url,
    'https://img.test/a.png?imageMogr2/thumbnail/384x/format/webp'
  )
  assert.ok(isImageLighterLoading(image))
  image.emit('image.loaded')
  assert.equal(isImageLighterLoading(image), false)
  lighter.destroy()
})

test('ImageLighter skips offscreen images so panning does not preload everything', async () => {
  const image = createImage({ x: 10000, y: 10000 })
  const tree = createTree([image])

  const lighter = new ImageLighter(tree, {
    updateDelay: 0,
    viewportPadding: 0,
  })
  await waitUpdate()

  assert.equal(image.fill.url, image.url)
  lighter.destroy()
})

test('ImageLighter waits for unknown-size images when runtime LOD patch is not ready', async () => {
  const image = createImage({
    ready: false,
    naturalWidth: undefined,
    naturalHeight: undefined,
  })
  image.image = undefined
  const tree = createTree([image])

  const lighter = new ImageLighter(tree, { updateDelay: 0 })
  await waitUpdate()

  assert.equal(image.fill.url, image.url)
  lighter.destroy()
})
