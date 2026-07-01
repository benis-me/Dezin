export interface ImageLighterOptions {
  disabled?: boolean
  /**
   * Candidate max-edge sizes for generated LOD images.
   */
  levels?: number[]
  /**
   * Skip optimization for small rendered images.
   */
  minRenderSize?: number
  /**
   * Extra world pixels around viewport treated as visible.
   */
  viewportPadding?: number
  /**
   * Debounce viewport / image updates.
   */
  updateDelay?: number
  /**
   * Max device pixel ratio used for LOD selection.
   */
  pixelRatioCap?: number
  /**
   * Allow already displayed images to switch LOD URLs after viewport changes.
   * Disabled by default to avoid blank reloads during zoom / pan.
   */
  switchLoadedImages?: boolean
  /**
   * Output format for the default object-storage image transform resolver.
   */
  format?: 'webp' | 'jpeg' | 'png'
  quality?: number
  /**
   * Custom LOD URL resolver. Return the original URL to opt out.
   */
  urlResolver?: (sourceUrl: string, level: ImageLighterLevel) => string
}

export type ImageLighterLevel =
  | { type: 'lod'; size: number }
  | { type: 'original' }

type LeaferLike = any

type ImageMeta = {
  sourceUrl: string
  originalUrl: string
  originalFill: unknown
  currentKey?: string
  off?: () => void
}

type BoundsData = {
  x: number
  y: number
  width: number
  height: number
}

const DEFAULT_LEVELS = [128, 256, 384, 640, 1024, 1600, 2048, 4096]
const DEFAULT_MIN_RENDER_SIZE = 64
const DEFAULT_VIEWPORT_PADDING = 768
const DEFAULT_UPDATE_DELAY = 80
const DEFAULT_PIXEL_RATIO_CAP = 2
const DEFAULT_FORMAT = 'webp'

const ZOOM = 'zoom'
const ZOOM_END = 'zoom.end'
const MOVE = 'move'
const MOVE_END = 'move.end'
const IMAGE_LOADED = 'image.loaded'
const IMAGE_ERROR = 'image.error'
const CHILD_ADD = 'child.add'
const CHILD_REMOVE = 'child.remove'
const PROPERTY_CHANGE = 'property.change'
const PROPERTY_LEAFER_CHANGE = 'property.leafer_change'

const META = Symbol('ImageLighterMeta')
const PATCH_STATE = Symbol.for('awen.leafer-react.image-lighter.patch')
export const IMAGE_LIGHTER_LOADING_FLAG = '__mcImageLighterLoading'

type RuntimePatchState = {
  count: number
  installed: boolean
  original?: {
    getLoadUrl?: (...args: unknown[]) => unknown
    setThumbView?: (...args: unknown[]) => unknown
    getThumbSize?: (...args: unknown[]) => unknown
  }
}

export function isImageLighterLoading(image: unknown) {
  return !!(image as Record<string, unknown> | null)?.[
    IMAGE_LIGHTER_LOADING_FLAG
  ]
}

export class ImageLighter {
  private readonly target: LeaferLike
  private readonly options: Required<
    Pick<
      ImageLighterOptions,
      | 'disabled'
      | 'levels'
      | 'minRenderSize'
      | 'viewportPadding'
      | 'updateDelay'
      | 'pixelRatioCap'
      | 'switchLoadedImages'
      | 'format'
    >
  > &
    Pick<ImageLighterOptions, 'quality' | 'urlResolver'>
  private eventBindings: Array<{ target: LeaferLike; ids: unknown }> = []
  private offCallbacks: Array<() => void> = []
  private imageOffCallbacks: Array<() => void> = []
  private optimizedImages = new Set<LeaferLike>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private raf = 0
  private destroyed = false
  private runtimePatchReady = false
  private runtimePatchState?: RuntimePatchState

  constructor(target: LeaferLike, options: ImageLighterOptions = {}) {
    this.target = target
    this.options = {
      disabled: options.disabled ?? false,
      levels: normalizeLevels(options.levels),
      minRenderSize: options.minRenderSize ?? DEFAULT_MIN_RENDER_SIZE,
      viewportPadding: options.viewportPadding ?? DEFAULT_VIEWPORT_PADDING,
      updateDelay: options.updateDelay ?? DEFAULT_UPDATE_DELAY,
      pixelRatioCap: options.pixelRatioCap ?? DEFAULT_PIXEL_RATIO_CAP,
      switchLoadedImages: options.switchLoadedImages ?? false,
      format: options.format ?? DEFAULT_FORMAT,
      quality: options.quality,
      urlResolver: options.urlResolver,
    }

    void this.installRuntimePatch()
    this.bindEvents()
    this.scheduleUpdate(0)
  }

  destroy() {
    this.destroyed = true
    this.cancelTimers()

    for (const image of this.optimizedImages) this.restoreImage(image)
    this.optimizedImages.clear()

    for (const off of this.imageOffCallbacks) off()
    this.imageOffCallbacks = []

    for (const binding of this.eventBindings) {
      binding.target?.off_?.(binding.ids)
    }
    this.eventBindings = []

    for (const off of this.offCallbacks) off()
    this.offCallbacks = []

    this.releaseRuntimePatch()
  }

  private async installRuntimePatch() {
    if (
      typeof CanvasRenderingContext2D === 'undefined' ||
      this.options.disabled
    ) {
      return
    }

    try {
      const { LeaferImage } = await import(/* @vite-ignore */ 'leafer-editor')
      if (this.destroyed) return
      const proto = LeaferImage?.prototype as LeaferLike
      if (!proto) return

      const state: RuntimePatchState =
        proto[PATCH_STATE] ??
        (proto[PATCH_STATE] = {
          count: 0,
          installed: false,
        })
      state.count++

      if (!state.installed) {
        state.installed = true
        state.original = {
          getLoadUrl: proto.getLoadUrl,
          setThumbView: proto.setThumbView,
          getThumbSize: proto.getThumbSize,
        }

        proto.getThumbSize = function patchedGetThumbSize(lod?: LeaferLike) {
          const lighter = lod?.__imageLighter
          if (!lighter) return state.original?.getThumbSize?.call(this, lod)
          this.__imageLighterLod = lod
          const size = Number(lod.thumb)
          if (!Number.isFinite(size) || size <= 0) return undefined
          return { width: size, height: size }
        }

        proto.getLoadUrl = function patchedGetLoadUrl(thumbSize?: {
          width?: number
          height?: number
        }) {
          const lod = this.__imageLighterLod ?? this.config?.lod
          const lighter = lod?.__imageLighter
          if (!lighter || !thumbSize) {
            return state.original?.getLoadUrl?.call(this, thumbSize)
          }
          const size = Math.max(
            Number(thumbSize.width) || 0,
            Number(thumbSize.height) || 0
          )
          return lighter.resolve(size)
        }

        proto.setThumbView = function patchedSetThumbView(view: unknown) {
          const lod = this.__imageLighterLod ?? this.config?.lod
          if (lod?.__imageLighter) {
            this.view = view
            this.width = lod.width
            this.height = lod.height
            return
          }
          return state.original?.setThumbView?.call(this, view)
        }
      }

      this.runtimePatchState = state
      this.runtimePatchReady = true
      this.scheduleUpdate(0)
    } catch {
      this.runtimePatchReady = false
    }
  }

  private releaseRuntimePatch() {
    const state = this.runtimePatchState
    if (!state) return
    state.count--
    if (state.count <= 0 && state.installed && state.original) {
      void import(/* @vite-ignore */ 'leafer-editor')
        .then(({ LeaferImage }) => {
          const proto = LeaferImage?.prototype as LeaferLike
          if (!proto || proto[PATCH_STATE] !== state) return
          proto.getLoadUrl = state.original?.getLoadUrl
          proto.setThumbView = state.original?.setThumbView
          proto.getThumbSize = state.original?.getThumbSize
          delete proto[PATCH_STATE]
        })
        .catch(() => {})
    }
    this.runtimePatchState = undefined
  }

  private bindEvents() {
    const entries: Array<[string | string[], (event?: unknown) => void, this]> =
      [
        [[ZOOM, ZOOM_END, MOVE, MOVE_END], this.handleViewportChange, this],
        [
          [IMAGE_LOADED, IMAGE_ERROR, CHILD_ADD, CHILD_REMOVE],
          this.handleTreeChange,
          this,
        ],
        [
          [PROPERTY_CHANGE, PROPERTY_LEAFER_CHANGE],
          this.handleTreeChange,
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

  private handleViewportChange() {
    this.scheduleUpdate(this.options.updateDelay)
  }

  private handleTreeChange() {
    this.scheduleUpdate(0)
  }

  private scheduleUpdate(delay = this.options.updateDelay) {
    if (this.options.disabled || this.destroyed) return
    this.cancelTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requestFrame(() => this.updateImages())
    }, delay)
  }

  private updateImages() {
    if (this.options.disabled || this.destroyed) return

    const viewport = this.getViewportBounds()
    for (const image of this.findImages()) {
      this.updateImage(image, viewport)
    }
  }

  private updateImage(image: LeaferLike, viewport?: BoundsData) {
    const sourceUrl = this.getImageUrl(image)
    if (!sourceUrl || !canOptimizeUrl(sourceUrl)) return

    if (viewport && !this.isVisible(image, viewport)) return

    const naturalSize = this.getNaturalSize(image)
    const ready = !!image.ready || !!image.image?.ready
    if (ready && !this.options.switchLoadedImages) return
    if (!ready && (!naturalSize || !this.runtimePatchReady)) return

    let meta = image[META] as ImageMeta | undefined
    if (!meta || meta.originalUrl !== sourceUrl) {
      this.restoreImage(image)
      meta = {
        sourceUrl: stripImageMogr2(sourceUrl),
        originalUrl: sourceUrl,
        originalFill: image.fill,
      }
      image[META] = meta
      this.optimizedImages.add(image)
      this.bindImageEvents(image, meta)
    }

    const renderSize = this.getRenderedMaxSize(image)
    if (renderSize < this.options.minRenderSize) return

    const level = this.pickLevel(renderSize, naturalSize)
    this.applyLevel(image, meta, level, !ready)
  }

  private bindImageEvents(image: LeaferLike, meta: ImageMeta) {
    if (!image?.on || !image?.off) return

    const onLoaded = () => {
      image[IMAGE_LIGHTER_LOADING_FLAG] = false
    }
    const onError = () => {
      if (!image[IMAGE_LIGHTER_LOADING_FLAG]) return
      image[IMAGE_LIGHTER_LOADING_FLAG] = false
      image.fill = meta.originalFill
      meta.currentKey = undefined
    }

    image.on(IMAGE_LOADED, onLoaded)
    image.on(IMAGE_ERROR, onError)
    const off = () => {
      image.off(IMAGE_LOADED, onLoaded)
      image.off(IMAGE_ERROR, onError)
    }
    meta.off = off
    this.imageOffCallbacks.push(off)
  }

  private applyLevel(
    image: LeaferLike,
    meta: ImageMeta,
    level: ImageLighterLevel,
    initialLoad: boolean
  ) {
    const key = level.type === 'original' ? 'original' : `lod:${level.size}`
    if (meta.currentKey === key) return

    const url = this.resolveUrl(meta.sourceUrl, level)
    if (!url) return

    if (!initialLoad && level.type !== 'original') {
      image[IMAGE_LIGHTER_LOADING_FLAG] = true
    }

    image.fill = {
      type: 'image',
      mode: 'stretch',
      url,
      ...(level.type === 'lod'
        ? {
            lod: {
              url: meta.sourceUrl,
              width: this.getNaturalSize(image)?.width ?? image.width,
              height: this.getNaturalSize(image)?.height ?? image.height,
              thumb: level.size,
              __imageLighter: {
                resolve: (size: number) =>
                  this.resolveUrl(meta.sourceUrl, { type: 'lod', size }),
              },
            },
          }
        : {}),
    }

    meta.currentKey = key
  }

  private restoreImage(image: LeaferLike) {
    const meta = image?.[META] as ImageMeta | undefined
    if (!meta) return
    image[IMAGE_LIGHTER_LOADING_FLAG] = false
    meta.off?.()
    image.fill = meta.originalFill
    delete image[META]
  }

  private pickLevel(
    renderSize: number,
    naturalSize?: { width: number; height: number }
  ): ImageLighterLevel {
    const naturalMax = naturalSize
      ? Math.max(naturalSize.width, naturalSize.height)
      : undefined
    if (naturalMax && renderSize >= naturalMax * 0.9)
      return { type: 'original' }

    const level = this.options.levels.find((size) => size >= renderSize)
    if (!level) return { type: 'original' }
    if (naturalMax && level >= naturalMax) return { type: 'original' }
    return { type: 'lod', size: level }
  }

  private resolveUrl(sourceUrl: string, level: ImageLighterLevel) {
    const resolver = this.options.urlResolver
    if (resolver) return resolver(sourceUrl, level)
    return defaultUrlResolver(sourceUrl, level, this.options)
  }

  private findImages(): LeaferLike[] {
    const found = safeCall(() => this.target.find?.('Image'))
    if (Array.isArray(found)) return found

    const images: LeaferLike[] = []
    const visit = (node: LeaferLike, depth: number) => {
      if (!node || depth > 10) return
      if (isImageNode(node)) images.push(node)
      const children = getChildren(node)
      for (const child of children) visit(child, depth + 1)
    }
    visit(this.target, 0)
    return images
  }

  private getImageUrl(image: LeaferLike): string | undefined {
    if (typeof image.url === 'string' && image.url) return image.url
    const fill = image.fill
    if (typeof fill?.url === 'string') return fill.url
    if (Array.isArray(fill) && typeof fill[0]?.url === 'string') {
      return fill[0].url
    }
    return undefined
  }

  private getRenderedMaxSize(image: LeaferLike) {
    const width =
      readPositiveNumber(image.width) ??
      readPositiveNumber(image.__?.width) ??
      0
    const height =
      readPositiveNumber(image.height) ??
      readPositiveNumber(image.__?.height) ??
      0
    const world =
      image.worldTransform ?? image.__world ?? this.target?.zoomLayer?.__
    const scale = Math.max(
      Math.abs(Number(world?.scaleX ?? world?.a ?? this.target?.scale) || 1),
      Math.abs(Number(world?.scaleY ?? world?.d ?? this.target?.scale) || 1)
    )
    const ratio =
      typeof window === 'undefined'
        ? 1
        : Math.min(window.devicePixelRatio || 1, this.options.pixelRatioCap)
    return Math.max(width, height) * scale * ratio
  }

  private getNaturalSize(image: LeaferLike) {
    const data = image.data?.data ?? image.data
    const width =
      readPositiveNumber(data?.naturalWidth) ??
      readPositiveNumber(image.__?.__naturalWidth) ??
      readPositiveNumber(image.image?.width)
    const height =
      readPositiveNumber(data?.naturalHeight) ??
      readPositiveNumber(image.__?.__naturalHeight) ??
      readPositiveNumber(image.image?.height)
    return width && height ? { width, height } : undefined
  }

  private getViewportBounds(): BoundsData | undefined {
    const bounds = normalizeBounds(
      this.target?.canvas?.bounds ?? this.target?.renderer?.canvas?.bounds
    )
    if (!bounds) return undefined
    const padding = this.options.viewportPadding
    return {
      x: bounds.x - padding,
      y: bounds.y - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    }
  }

  private isVisible(image: LeaferLike, viewport: BoundsData) {
    const bounds =
      normalizeBounds(safeCall(() => image.getBounds?.('render'))) ??
      normalizeBounds(safeCall(() => image.getBounds?.('box'))) ??
      normalizeBounds(image.renderBounds) ??
      normalizeBounds(image.boxBounds) ??
      normalizeBounds(image.__world) ??
      normalizeBounds(image.__local)
    return bounds ? hitBounds(viewport, bounds) : true
  }

  private cancelTimers() {
    this.cancelTimer()
    if (this.raf) {
      globalThis.cancelAnimationFrame?.(this.raf)
      this.raf = 0
    }
  }

  private cancelTimer() {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private requestFrame(callback: FrameRequestCallback) {
    const request = globalThis.requestAnimationFrame
    if (request) {
      this.raf = request((time) => {
        this.raf = 0
        callback(time)
      })
      return
    }
    callback(0)
  }
}

function defaultUrlResolver(
  sourceUrl: string,
  level: ImageLighterLevel,
  options: Pick<ImageLighterOptions, 'format' | 'quality'>
) {
  if (level.type === 'original') {
    return appendImageMogr2(sourceUrl, {
      format: options.format,
      quality: options.quality,
    })
  }

  return appendImageMogr2(sourceUrl, {
    size: level.size,
    format: options.format,
    quality: options.quality,
  })
}

function appendImageMogr2(
  sourceUrl: string,
  options: { size?: number; format?: string; quality?: number }
) {
  if (!canOptimizeUrl(sourceUrl)) return sourceUrl
  const parts = ['imageMogr2']
  if (options.size) parts.push('thumbnail', `${Math.round(options.size)}x`)
  if (options.quality) parts.push('quality', `${options.quality}`)
  if (options.format) parts.push('format', options.format)
  const slim = options.quality ? '|imageSlim' : ''
  const baseUrl = stripImageMogr2(sourceUrl)
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${parts.join('/')}${slim}`
}

function stripImageMogr2(url: string) {
  const queryIndex = url.indexOf('?imageMogr2')
  if (queryIndex >= 0) return url.slice(0, queryIndex)
  const ampIndex = url.indexOf('&imageMogr2')
  if (ampIndex >= 0) return url.slice(0, ampIndex)
  return url
}

function canOptimizeUrl(url: string) {
  return /^https?:\/\//i.test(url) && !/\.gif(?:[?#]|$)/i.test(url)
}

function normalizeLevels(levels?: number[]) {
  const values = (levels?.length ? levels : DEFAULT_LEVELS)
    .map((value) => Math.round(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  return Array.from(new Set(values)).sort((a, b) => a - b)
}

function isImageNode(node: LeaferLike) {
  return node?.__tag === 'Image' || node?.tag === 'Image'
}

function getChildren(node: LeaferLike): LeaferLike[] {
  return Array.isArray(node?.children) ? node.children : []
}

function safeCall<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function readPositiveNumber(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
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

function hitBounds(a: BoundsData, b: BoundsData) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}
