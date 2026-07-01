export interface ViewportLighterOptions {
  /**
   * Official-compatible threshold. Set false to disable bitmap transform fallback.
   */
  sliceRender?: number | false
  /**
   * Debounce window for wheel / touchpad events that emit repeated zoom.end.
   */
  transformEndDelay?: number
  /**
   * Direct children threshold before patching a render branch with viewport culling.
   */
  minIndexedChildren?: number
  /**
   * Spatial index tile size in the optimized branch coordinate system.
   */
  tileSize?: number
  /**
   * Extra world pixels rendered around the viewport to avoid edge pop-in.
   */
  viewportPadding?: number
  /**
   * Direct children threshold before using bitmap viewport transforms during zoom.
   */
  minTransformChildren?: number
  disabled?: boolean
}

type LeaferLike = any

const ZOOM_START = 'zoom.start'
const ZOOM = 'zoom'
const ZOOM_END = 'zoom.end'

const DEFAULT_SLICE_RENDER = 10000
const DEFAULT_TRANSFORM_END_DELAY = 80
const DEFAULT_MIN_INDEXED_CHILDREN = 2000
const DEFAULT_TILE_SIZE = 2048
const DEFAULT_VIEWPORT_PADDING = 512
const DEFAULT_MIN_TRANSFORM_CHILDREN = 30000
const PROPERTY_CHANGE = 'property.change'
const PROPERTY_LEAFER_CHANGE = 'property.leafer_change'

const INDEXED_ATTRS = new Set([
  'x',
  'y',
  'width',
  'height',
  'scale',
  'scaleX',
  'scaleY',
  'rotation',
  'visible',
  'opacity',
  'zIndex',
])

type MatrixState = {
  x: number
  y: number
  scaleX: number
  scaleY: number
}

type BoundsData = {
  x: number
  y: number
  width: number
  height: number
}

type RendererPatch = {
  renderer: LeaferLike
  renderOnce: (...args: unknown[]) => unknown
}

type BranchPatch = {
  branch: LeaferLike
  renderBranch: (...args: unknown[]) => unknown
  index: BranchSpatialIndex
}

export class ViewportLighter {
  private readonly target: LeaferLike
  private readonly options: Required<
    Pick<
      ViewportLighterOptions,
      | 'transformEndDelay'
      | 'disabled'
      | 'minIndexedChildren'
      | 'tileSize'
      | 'viewportPadding'
      | 'minTransformChildren'
    >
  > &
    Pick<ViewportLighterOptions, 'sliceRender'>
  private eventBindings: Array<{ target: LeaferLike; ids: unknown }> = []
  private offCallbacks: Array<() => void> = []
  private rendererPatch?: RendererPatch
  private branchPatches = new Map<LeaferLike, BranchPatch>()
  private indexBranch?: LeaferLike | null
  private active = false
  private base?: MatrixState
  private raf = 0
  private endTimer: ReturnType<typeof setTimeout> | undefined
  private wasRendererRunning = false
  private savedStyle?: {
    transform: string
    transformOrigin: string
    willChange: string
  }

  constructor(target: LeaferLike, options: ViewportLighterOptions = {}) {
    this.target = target
    this.options = {
      sliceRender: options.sliceRender ?? DEFAULT_SLICE_RENDER,
      transformEndDelay:
        options.transformEndDelay ?? DEFAULT_TRANSFORM_END_DELAY,
      minIndexedChildren:
        options.minIndexedChildren ?? DEFAULT_MIN_INDEXED_CHILDREN,
      tileSize: options.tileSize ?? DEFAULT_TILE_SIZE,
      viewportPadding: options.viewportPadding ?? DEFAULT_VIEWPORT_PADDING,
      minTransformChildren:
        options.minTransformChildren ??
        (typeof options.sliceRender === 'number'
          ? options.sliceRender
          : DEFAULT_MIN_TRANSFORM_CHILDREN),
      disabled: options.disabled ?? false,
    }

    this.patchRenderer()
    this.bindEvents()
  }

  destroy() {
    this.cancelTimers()
    this.restoreCanvasStyle()
    this.restoreRenderer()
    this.restoreRendererPatch()
    this.restoreBranchPatches()

    for (const binding of this.eventBindings) {
      binding.target?.off_?.(binding.ids)
    }
    this.eventBindings = []
    for (const off of this.offCallbacks) off()
    this.offCallbacks = []
  }

  private bindEvents() {
    const entries: Array<[string | string[], (event?: unknown) => void, this]> =
      [
        [ZOOM_START, this.handleStart, this],
        [ZOOM, this.handleTransform, this],
        [ZOOM_END, this.handleEnd, this],
        [
          [PROPERTY_CHANGE, PROPERTY_LEAFER_CHANGE],
          this.handlePropertyChange,
          this,
        ],
      ]

    for (const target of this.getEventTargets()) {
      if (target?.on_) {
        this.eventBindings.push({ target, ids: target.on_(entries) })
        continue
      }

      if (!target?.on || !target?.off) continue

      for (const [types, handler, ctx] of entries) {
        for (const type of Array.isArray(types) ? types : [types]) {
          const bound = handler.bind(ctx)
          target.on(type, bound)
          this.offCallbacks.push(() => target.off(type, bound))
        }
      }
    }
  }

  private getEventTargets() {
    const targets = [this.target]
    const app = this.target?.app
    if (app && app !== this.target) targets.push(app)
    return targets
  }

  private handleStart() {
    if (this.options.disabled) return
    this.ensureRenderPatch()
    if (!this.shouldUseViewportTransform()) return

    const view = this.getCanvasView()
    const renderer = this.target?.renderer
    if (!view || !renderer || !this.target?.zoomLayer) return

    this.cancelTimers()

    if (!this.active) {
      this.active = true
      this.base = this.readMatrix()
      this.savedStyle = {
        transform: view.style.transform || '',
        transformOrigin: view.style.transformOrigin || '',
        willChange: view.style.willChange || '',
      }
      view.style.transformOrigin = '0 0'
      view.style.willChange = 'transform'

      this.wasRendererRunning = renderer.running !== false
      if (this.wasRendererRunning) renderer.stop?.()
    }
  }

  private handleTransform() {
    if (!this.active || !this.base) return
    if (this.raf) return
    this.raf = this.requestFrame(() => {
      this.raf = 0
      this.applyTransform()
    })
  }

  private handleEnd() {
    if (!this.active) return
    this.cancelEndTimer()
    this.endTimer = setTimeout(() => {
      void this.finishTransform()
    }, this.options.transformEndDelay)
  }

  private handlePropertyChange(event?: unknown) {
    const change = event as { attrName?: string; target?: unknown } | undefined
    const attrName = change?.attrName
    if (!attrName || !INDEXED_ATTRS.has(attrName)) return
    if (
      change?.target === this.target ||
      change?.target === this.target?.zoomLayer
    ) {
      return
    }
    this.invalidateIndexes()
  }

  private async finishTransform() {
    if (!this.active) return

    this.active = false
    this.cancelFrame()

    const overlay = this.createOverlay()
    this.restoreCanvasStyle()
    this.restoreRenderer()

    this.requestRender()
    await this.waitForIdleFrame()
    overlay?.remove()
  }

  private applyTransform() {
    const view = this.getCanvasView()
    if (!view || !this.base) return

    const current = this.readMatrix()
    const scaleX = safeDivide(current.scaleX, this.base.scaleX)
    const scaleY = safeDivide(current.scaleY, this.base.scaleY)
    const x = current.x - this.base.x * scaleX
    const y = current.y - this.base.y * scaleY

    view.style.transform = `matrix(${formatNumber(scaleX)}, 0, 0, ${formatNumber(
      scaleY
    )}, ${formatNumber(x)}, ${formatNumber(y)})`
  }

  private readMatrix(): MatrixState {
    const data = this.target.zoomLayer?.__ ?? {}
    return {
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      scaleX: Number(data.scaleX) || 1,
      scaleY: Number(data.scaleY) || 1,
    }
  }

  private getCanvasView(): HTMLCanvasElement | undefined {
    return this.target?.canvas?.view ?? this.target?.renderer?.canvas?.view
  }

  private restoreCanvasStyle() {
    const view = this.getCanvasView()
    if (!view || !this.savedStyle) return
    view.style.transform = this.savedStyle.transform
    view.style.transformOrigin = this.savedStyle.transformOrigin
    view.style.willChange = this.savedStyle.willChange
    this.savedStyle = undefined
  }

  private restoreRenderer() {
    const renderer = this.target?.renderer
    if (this.wasRendererRunning && renderer?.running === false) {
      renderer.start?.()
    }
    this.wasRendererRunning = false
  }

  private requestRender() {
    if (this.target?.requestRender) {
      this.target.requestRender(true)
      return
    }
    if (this.target?.renderer?.update) {
      this.target.renderer.update(true)
      return
    }
    if (this.target?.forceRender) {
      this.target.forceRender()
      return
    }
    this.target?.renderer?.render?.()
  }

  private patchRenderer() {
    const renderer = this.target?.renderer
    if (!renderer?.renderOnce || this.rendererPatch) return

    const lighter = this
    const renderOnce = renderer.renderOnce
    renderer.renderOnce = function patchedRenderOnce(...args: unknown[]) {
      lighter.ensureRenderPatch()
      return renderOnce.apply(this, args)
    }

    this.rendererPatch = { renderer, renderOnce }
  }

  private restoreRendererPatch() {
    if (!this.rendererPatch) return
    this.rendererPatch.renderer.renderOnce = this.rendererPatch.renderOnce
    this.rendererPatch = undefined
  }

  private ensureRenderPatch() {
    if (this.options.disabled) return
    let branch = this.indexBranch
    if (!this.isIndexBranchUsable(branch)) {
      branch = this.findIndexBranch()
      this.indexBranch = branch ?? null
    }
    if (!branch || this.branchPatches.has(branch)) return
    if (getChildren(branch).length >= this.options.minIndexedChildren) {
      this.patchBranch(branch)
    }
  }

  private isIndexBranchUsable(branch: LeaferLike | null | undefined) {
    return !!(
      branch &&
      typeof branch.__renderBranch === 'function' &&
      !branch.__hasMask &&
      getChildren(branch).length > 0
    )
  }

  private findIndexBranch() {
    const roots =
      this.target?.zoomLayer && this.target.zoomLayer !== this.target
        ? [this.target.zoomLayer, this.target]
        : [this.target]
    let best: LeaferLike | undefined
    let named: LeaferLike | undefined

    const visit = (node: LeaferLike, depth: number) => {
      if (!node || depth > 5 || named) return
      const children = getChildren(node)
      if (
        typeof node.__renderBranch === 'function' &&
        !node.__hasMask &&
        children.length > 0
      ) {
        if (node.name === 'nodes') {
          named = node
          return
        }
        if (
          children.length >= this.options.minIndexedChildren &&
          (!best || children.length > getChildren(best).length)
        ) {
          best = node
        }
      }
      for (const child of children) visit(child, depth + 1)
    }

    for (const root of roots) visit(root, 0)
    return named ?? best
  }

  private patchBranch(branch: LeaferLike) {
    if (this.branchPatches.has(branch)) return

    const renderBranch = branch.__renderBranch
    if (typeof renderBranch !== 'function') return

    const index = new BranchSpatialIndex(
      this.options.tileSize,
      this.options.viewportPadding
    )
    const lighter = this

    branch.__renderBranch = function patchedRenderBranch(
      canvas: unknown,
      options: Record<string, unknown>
    ) {
      if (!lighter.shouldCullBranch(this, options)) {
        return renderBranch.call(this, canvas, options)
      }

      const visibleChildren = index.getVisibleChildren(this, options.bounds)
      if (!visibleChildren) return renderBranch.call(this, canvas, options)

      const previousChildren = this.children
      this.children = visibleChildren
      try {
        return renderBranch.call(this, canvas, options)
      } finally {
        this.children = previousChildren
      }
    }

    this.branchPatches.set(branch, { branch, renderBranch, index })
  }

  private restoreBranchPatches() {
    for (const patch of this.branchPatches.values()) {
      patch.branch.__renderBranch = patch.renderBranch
    }
    this.branchPatches.clear()
  }

  private shouldCullBranch(
    branch: LeaferLike,
    options?: Record<string, unknown>
  ) {
    return !!(
      !this.options.disabled &&
      options?.bounds &&
      !options.cellList &&
      !options.topRendering &&
      !branch.__hasMask &&
      getChildren(branch).length >= this.options.minIndexedChildren
    )
  }

  private shouldUseViewportTransform() {
    if (this.options.sliceRender === false) return false
    if (this.options.minTransformChildren <= 0) return true
    const branch = this.findIndexBranch()
    return (
      !!branch &&
      getChildren(branch).length >= this.options.minTransformChildren
    )
  }

  private invalidateIndexes() {
    for (const patch of this.branchPatches.values()) patch.index.invalidate()
  }

  private createOverlay() {
    const view = this.getCanvasView()
    if (
      typeof document === 'undefined' ||
      !view ||
      !view.parentElement ||
      !view.style.transform
    ) {
      return null
    }

    const overlay = document.createElement('canvas')
    overlay.width = view.width
    overlay.height = view.height

    const style = overlay.style
    style.position = 'absolute'
    style.left = view.style.left || '0px'
    style.top = view.style.top || '0px'
    style.width = view.style.width || `${view.clientWidth}px`
    style.height = view.style.height || `${view.clientHeight}px`
    style.pointerEvents = 'none'
    style.transformOrigin = view.style.transformOrigin || '0 0'
    style.transform = view.style.transform
    style.zIndex = `${(Number(view.style.zIndex) || 0) + 1}`

    const context = overlay.getContext('2d')
    context?.drawImage(view, 0, 0)
    view.parentElement.appendChild(overlay)
    return overlay
  }

  private cancelTimers() {
    this.cancelFrame()
    this.cancelEndTimer()
  }

  private cancelFrame() {
    if (!this.raf) return
    const cancel = globalThis.cancelAnimationFrame
    cancel?.(this.raf)
    this.raf = 0
  }

  private cancelEndTimer() {
    if (!this.endTimer) return
    clearTimeout(this.endTimer)
    this.endTimer = undefined
  }

  private requestFrame(callback: FrameRequestCallback) {
    const request = globalThis.requestAnimationFrame
    if (request) return request(callback)
    callback(0)
    return 0
  }

  private waitForIdleFrame() {
    return new Promise<void>((resolve) => {
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        window.requestIdleCallback(() => resolve(), { timeout: 32 })
        return
      }
      this.requestFrame(() => resolve())
    })
  }
}

class BranchSpatialIndex {
  private readonly tileSize: number
  private readonly viewportPadding: number
  private childrenRef?: LeaferLike[]
  private childCount = 0
  private dirty = true
  private grid = new Map<string, LeaferLike[]>()
  private order = new Map<LeaferLike, number>()
  private always = new Set<LeaferLike>()

  constructor(tileSize: number, viewportPadding: number) {
    this.tileSize = tileSize
    this.viewportPadding = viewportPadding
  }

  invalidate() {
    this.dirty = true
  }

  getVisibleChildren(branch: LeaferLike, worldBounds: unknown) {
    const children = getChildren(branch)
    if (!children.length) return children
    if (
      this.dirty ||
      this.childrenRef !== children ||
      this.childCount !== children.length
    ) {
      this.rebuild(branch, children)
    }

    const bounds = toBranchBounds(branch, worldBounds, this.viewportPadding)
    if (!bounds) return children

    const matches = new Set<LeaferLike>(this.always)
    for (
      let x = tileStart(bounds.x, this.tileSize);
      x <= tileEnd(bounds.x, bounds.width, this.tileSize);
      x++
    ) {
      for (
        let y = tileStart(bounds.y, this.tileSize);
        y <= tileEnd(bounds.y, bounds.height, this.tileSize);
        y++
      ) {
        const bucket = this.grid.get(tileKey(x, y))
        if (!bucket) continue
        for (const child of bucket) matches.add(child)
      }
    }

    return [...matches].sort(
      (a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0)
    )
  }

  private rebuild(branch: LeaferLike, children: LeaferLike[]) {
    this.childrenRef = children
    this.childCount = children.length
    this.dirty = false
    this.grid.clear()
    this.order.clear()
    this.always.clear()

    children.forEach((child, index) => {
      this.order.set(child, index)
      const bounds = getChildBranchBounds(child, branch)
      if (!bounds) {
        this.always.add(child)
        return
      }

      const startX = tileStart(bounds.x, this.tileSize)
      const endX = tileEnd(bounds.x, bounds.width, this.tileSize)
      const startY = tileStart(bounds.y, this.tileSize)
      const endY = tileEnd(bounds.y, bounds.height, this.tileSize)
      const cellCount = (endX - startX + 1) * (endY - startY + 1)
      if (cellCount > 256) {
        this.always.add(child)
        return
      }

      for (let x = startX; x <= endX; x++) {
        for (let y = startY; y <= endY; y++) {
          const key = tileKey(x, y)
          const bucket = this.grid.get(key)
          if (bucket) bucket.push(child)
          else this.grid.set(key, [child])
        }
      }
    })
  }
}

function getChildren(node: LeaferLike): LeaferLike[] {
  return Array.isArray(node?.children) ? node.children : []
}

function getChildBranchBounds(
  child: LeaferLike,
  branch: LeaferLike
): BoundsData | undefined {
  const bounds =
    readBounds(() => child.getBounds?.('render', branch)) ??
    readBounds(() => child.getBounds?.('box', branch)) ??
    readBounds(() => child.renderBounds) ??
    readBounds(() => child.boxBounds) ??
    readBounds(() => child.__local) ??
    readBounds(() => child.__layout?.renderBounds) ??
    readBounds(() => child.__layout?.boxBounds)

  return bounds ? normalizeBounds(bounds) : undefined
}

function toBranchBounds(
  branch: LeaferLike,
  worldBounds: unknown,
  padding: number
): BoundsData | undefined {
  const bounds = normalizeBounds(worldBounds)
  if (!bounds) return undefined

  const x = bounds.x - padding
  const y = bounds.y - padding
  const right = bounds.x + bounds.width + padding
  const bottom = bounds.y + bounds.height + padding
  const points = [
    toBranchPoint(branch, { x, y }),
    toBranchPoint(branch, { x: right, y }),
    toBranchPoint(branch, { x: right, y: bottom }),
    toBranchPoint(branch, { x, y: bottom }),
  ]

  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...ys)

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function toBranchPoint(branch: LeaferLike, point: { x: number; y: number }) {
  if (typeof branch?.getInnerPoint === 'function') {
    try {
      return branch.getInnerPoint(point)
    } catch {
      return point
    }
  }
  return point
}

function readBounds(read: () => unknown) {
  try {
    return read()
  } catch {
    return undefined
  }
}

function normalizeBounds(bounds: unknown): BoundsData | undefined {
  const value = bounds as {
    x?: unknown
    y?: unknown
    width?: unknown
    height?: unknown
  }
  const x = Number(value?.x)
  const y = Number(value?.y)
  const width = Number(value?.width)
  const height = Number(value?.height)
  if (![x, y, width, height].every(Number.isFinite)) return undefined
  if (width < 0 || height < 0) return undefined
  return { x, y, width, height }
}

function tileStart(value: number, tileSize: number) {
  return Math.floor(value / tileSize)
}

function tileEnd(value: number, size: number, tileSize: number) {
  return Math.floor((value + size) / tileSize)
}

function tileKey(x: number, y: number) {
  return `${x}:${y}`
}

function safeDivide(value: number, base: number) {
  return base ? value / base : 1
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  const normalized = Math.round(value * 1_000_000) / 1_000_000
  return `${Object.is(normalized, -0) ? 0 : normalized}`
}
