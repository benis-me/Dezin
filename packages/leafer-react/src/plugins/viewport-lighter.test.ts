import assert from 'node:assert/strict'
import test from 'node:test'
import { ViewportLighter } from './viewport-lighter.ts'

function createFakeTree() {
  const handlers = new Map<string, Array<(event?: any) => void>>()
  const view = {
    style: {} as Record<string, string>,
    width: 100,
    height: 80,
    clientWidth: 100,
    clientHeight: 80,
    parentElement: null,
  }

  const renderer = {
    running: true,
    stopCount: 0,
    startCount: 0,
    renderCount: 0,
    stop() {
      this.running = false
      this.stopCount++
    },
    start() {
      this.running = true
      this.startCount++
    },
    render(callback?: () => void) {
      callback?.()
      this.renderCount++
    },
    requestLayout() {},
    canvas: {
      view,
      bounds: {
        includes: () => true,
      },
      clear() {},
      updateRender() {},
    },
  }

  const tree: any = {
    renderer,
    canvas: renderer.canvas,
    __world: {},
    zoomLayer: {
      __: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    },
    children: [],
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
    forceRender() {
      renderer.renderCount++
    },
    emit(type: string, event?: any) {
      handlers.get(type)?.forEach((handler) => handler(event))
    },
    handlerCount() {
      return handlers.size
    },
  }

  return { tree, renderer, view }
}

function createEventTarget() {
  const handlers = new Map<string, Array<(event?: any) => void>>()
  return {
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
}

function createBounds(x: number, y: number, width: number, height: number) {
  return {
    x,
    y,
    width,
    height,
    hit(other: any) {
      return hitBounds(this, other)
    },
    includes() {
      return false
    },
  }
}

function hitBounds(a: any, b: any) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

function createRenderableBranch(childBounds: Array<[number, number, number, number]>) {
  const rendered: number[] = []
  const branchChildCounts: number[] = []
  const branch: any = {
    name: 'nodes',
    __hasMask: false,
    children: childBounds.map(([x, y, width, height], index) => ({
      innerId: index + 1,
      __worldOpacity: 1,
      getBounds: () => ({ x, y, width, height }),
      __render() {
        rendered.push(index)
      },
    })),
    getInnerPoint(point: any, _relative?: any, _distance?: boolean, change?: boolean) {
      return change ? point : { ...point }
    },
    __renderBranch(_canvas: any, options: any) {
      branchChildCounts.push(this.children.length)
      for (const child of this.children) {
        if (!options.bounds || options.bounds.hit(child.getBounds())) {
          child.__render()
        }
      }
    },
  }

  return { branch, rendered, branchChildCounts }
}

test('ViewportLighter installs with one constructor call and removes listeners', () => {
  const { tree } = createFakeTree()

  const lighter = new ViewportLighter(tree, { sliceRender: 10000 })

  assert.ok(tree.handlerCount() > 0)
  lighter.destroy()
  assert.equal(tree.handlerCount(), 0)
})

test('ViewportLighter keeps panning native so newly exposed content can render immediately', () => {
  const originalRaf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }) as typeof requestAnimationFrame

  try {
    const { tree, renderer, view } = createFakeTree()
    const lighter = new ViewportLighter(tree, { sliceRender: false })

    tree.emit('move.start')
    tree.zoomLayer.__ = { x: 5, y: 7, scaleX: 1, scaleY: 1 }
    tree.emit('move')

    assert.equal(renderer.stopCount, 0)
    assert.equal(view.style.transform, undefined)
    lighter.destroy()
  } finally {
    globalThis.requestAnimationFrame = originalRaf
  }
})

test('ViewportLighter also reacts to app-level zoom events when constructed with app.tree', () => {
  const originalRaf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }) as typeof requestAnimationFrame

  try {
    const { tree, view } = createFakeTree()
    const app = createEventTarget()
    tree.app = app
    const lighter = new ViewportLighter(tree, {
      sliceRender: 10000,
      minTransformChildren: 0,
    })

    app.emit('zoom.start')
    tree.zoomLayer.__ = { x: 5, y: 7, scaleX: 2, scaleY: 2 }
    app.emit('zoom')

    assert.equal(view.style.transform, 'matrix(2, 0, 0, 2, 5, 7)')
    lighter.destroy()
    assert.equal(app.handlerCount(), 0)
  } finally {
    globalThis.requestAnimationFrame = originalRaf
  }
})

test('ViewportLighter pauses render during viewport transforms and restores after idle', async () => {
  const originalRaf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0)
    return 1
  }) as typeof requestAnimationFrame

  try {
    const { tree, renderer, view } = createFakeTree()
    const lighter = new ViewportLighter(tree, {
      sliceRender: 10000,
      transformEndDelay: 0,
      minTransformChildren: 0,
    })

    tree.emit('zoom.start')
    tree.zoomLayer.__ = { x: 10, y: 20, scaleX: 2, scaleY: 2 }
    tree.emit('zoom')

    assert.equal(renderer.stopCount, 1)
    assert.equal(
      view.style.transform,
      'matrix(2, 0, 0, 2, 10, 20)'
    )

    tree.emit('zoom.end')
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(renderer.startCount, 1)
    assert.equal(view.style.transform, '')
    assert.equal(renderer.renderCount, 1)
    lighter.destroy()
  } finally {
    globalThis.requestAnimationFrame = originalRaf
  }
})

test('ViewportLighter installs a lazy renderer patch and renders only visible branch children', () => {
  const { tree, renderer } = createFakeTree()
  const { branch, rendered, branchChildCounts } = createRenderableBranch([
    [0, 0, 100, 100],
    [2000, 0, 100, 100],
    [50, 50, 100, 100],
  ])

  tree.children = [branch]
  tree.__renderBranch = (_canvas: any, options: any) => {
    for (const child of tree.children) child.__renderBranch({}, options)
  }
  renderer.renderOnce = () => {
    tree.__renderBranch({}, { bounds: createBounds(0, 0, 200, 200) })
  }
  const originalRenderOnce = renderer.renderOnce
  const originalRenderBranch = branch.__renderBranch

  const lighter = new ViewportLighter(tree, {
    sliceRender: false,
    minIndexedChildren: 1,
    tileSize: 256,
    viewportPadding: 0,
  })

  renderer.renderOnce()

  assert.deepEqual(rendered, [0, 2])
  assert.deepEqual(branchChildCounts, [2])
  assert.notEqual(renderer.renderOnce, originalRenderOnce)
  assert.notEqual(branch.__renderBranch, originalRenderBranch)
  lighter.destroy()
  assert.equal(renderer.renderOnce, originalRenderOnce)
  assert.equal(branch.__renderBranch, originalRenderBranch)
})
