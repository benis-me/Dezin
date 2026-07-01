import {
  Box,
  EditorMoveEvent,
  EditorScaleEvent,
  Group,
  KeyEvent,
  Line,
  PointerEvent,
  Text,
  type App,
  type IUI,
} from 'leafer-editor'
import {
  boundsIntersect,
  calculateDistanceGuides,
  calculateEqualSpacingGuides,
  calculateResizeSnapScale,
  createBoundsFromPoints,
  createSnapLines,
  createSnapPointsFromBounds,
  getCollisionPointsFromCollisions,
  getResizeSide,
  getResizeSideFromOrigin,
  getResizeSnapPoints,
  getWorldSnapThreshold,
  resolveSnapCollisions,
  resolveSnapDeltas,
  type SnapBounds,
  type SnapCollision,
  type SnapDistanceGuide,
  type SnapDeltas,
  type SnapEqualSpacingGuide,
  type SnapLine,
  type SnapPoint,
  type SnapResizeSides,
} from './snap-geometry.ts'

interface CanvasSnapOptions {
  parentContainer: IUI
  screenThreshold?: number
  lineColor?: string
  strokeWidth?: number
  linePadding?: number
  pointSize?: number
  labelOffset?: number
}

type SnapTarget = IUI & {
  safeChange?: (fn: () => void) => void
}

type Point = { x: number; y: number }

const DEFAULT_OPTIONS = {
  screenThreshold: 6,
  lineColor: '#FF3B30',
  strokeWidth: 1,
  linePadding: 0,
  pointSize: 7,
  labelOffset: 18,
}

export class CanvasSnap {
  private readonly app: App
  private readonly options: Required<CanvasSnapOptions>
  private snapLines: SnapLine[] = []
  private enabled = false
  private collecting = false
  private isKeyboardMove = false
  private verticalLines: Line[] = []
  private horizontalLines: Line[] = []
  private pointMarkers: Group[] = []
  private distanceLines: Line[] = []
  private distanceLabels: Box[] = []
  private equalSpacingBoxes: Box[] = []
  private snapBounds: SnapBounds[] = []

  constructor(app: App, options: CanvasSnapOptions) {
    this.app = app
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  enable(enabled: boolean) {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (enabled) {
      this.attach()
    } else {
      this.detach()
      this.destroy()
    }
  }

  destroy = () => {
    this.clearGuides()
    this.snapLines = []
    this.snapBounds = []
    this.collecting = false
  }

  private attach() {
    const editor = this.app.editor
    editor?.on(EditorMoveEvent.BEFORE_MOVE, this.collect)
    editor?.on(EditorScaleEvent.BEFORE_SCALE, this.collect)
    editor?.on(EditorMoveEvent.MOVE, this.handleMove)
    editor?.on(EditorScaleEvent.SCALE, this.handleScale)
    this.app.on(PointerEvent.UP, this.destroy)
    this.app.on([KeyEvent.DOWN, KeyEvent.UP], this.handleKeyEvent, {
      capture: true,
    })
  }

  private detach() {
    const editor = this.app.editor
    editor?.off(EditorMoveEvent.BEFORE_MOVE, this.collect)
    editor?.off(EditorScaleEvent.BEFORE_SCALE, this.collect)
    editor?.off(EditorMoveEvent.MOVE, this.handleMove)
    editor?.off(EditorScaleEvent.SCALE, this.handleScale)
    this.app.off(PointerEvent.UP, this.destroy)
    this.app.off([KeyEvent.DOWN, KeyEvent.UP], this.handleKeyEvent, {
      capture: true,
    })
  }

  private collect = () => {
    if (!this.enabled || this.collecting) return
    const entries = this.collectSnapElements()
      .map((element) => ({
        element,
        bounds: getElementSnapBounds(element as SnapTarget, this.app.tree),
      }))
      .filter(
        (entry): entry is { element: IUI; bounds: SnapBounds } =>
          Boolean(entry.bounds)
      )

    this.snapBounds = entries.map((entry) => entry.bounds)
    const points = entries.flatMap((entry) =>
      createSnapPointsFromBounds(entry.bounds, entry.element.id)
    )
    this.snapLines = createSnapLines(points)
    this.collecting = true
  }

  private handleMove = (event: EditorMoveEvent) => {
    if (!this.enabled || !event.moveX && !event.moveY) return
    this.execute(event.target as SnapTarget, { mode: 'move' })
  }

  private handleScale = (event: EditorScaleEvent) => {
    if (!this.enabled || !event.scaleX && !event.scaleY) return
    this.execute(event.target as SnapTarget, {
      mode: 'scale',
      resizeDirection: event.direction,
      resizeOrigin: getLocalPoint(this.app.tree, event.worldOrigin),
      resizeWorldOrigin: event.worldOrigin,
    })
  }

  private execute(
    target: SnapTarget,
    operation: {
      mode: 'move' | 'scale'
      resizeDirection?: number
      resizeOrigin?: Point | null
      resizeWorldOrigin?: Point | null
    }
  ) {
    if (!target || !this.snapLines.length) {
      this.clearGuides()
      return
    }

    const threshold = getWorldSnapThreshold(
      this.options.screenThreshold,
      this.app.tree?.scale as number
    )
    const targetPoints = getElementSnapPoints(target, this.app.tree)
    const targetBounds = createBoundsFromPoints(targetPoints)
    const resizeSides =
      operation.mode === 'scale'
        ? getScaleResizeSides(
            operation.resizeDirection,
            targetBounds,
            operation.resizeOrigin
          )
        : null
    const snapTargetPoints =
      operation.mode === 'scale'
        ? getScaleSnapPoints(targetPoints, resizeSides)
        : targetPoints
    const snap = resolveSnapDeltas({
      targetPoints: snapTargetPoints,
      snapLines: this.snapLines,
      threshold,
    })

    if (operation.mode === 'move' && !this.isKeyboardMove) {
      this.applySnapOffset(target, snap)
    } else if (operation.mode === 'scale') {
      this.applyResizeSnap(
        target,
        snap,
        targetBounds,
        resizeSides,
        operation.resizeWorldOrigin
      )
    }

    const snappedTargetPoints = getElementSnapPoints(target, this.app.tree)
    const snappedTargetBounds = createBoundsFromPoints(snappedTargetPoints)
    const snapped = resolveSnapDeltas({
      targetPoints: snappedTargetPoints,
      snapLines: this.snapLines,
      threshold: Math.max(1, threshold / 4),
    })
    const snappedCollisions = resolveSnapCollisions({
      targetPoints: snappedTargetPoints,
      snapLines: this.snapLines,
      threshold: Math.max(1, threshold / 4),
    })

    this.renderGuides(
      snapped,
      snappedCollisions,
      snappedTargetPoints,
      snappedTargetBounds
    )
  }

  private collectSnapElements() {
    const selected = new Set(
      (this.app.editor?.list ?? []).map((element) => element.id)
    )
    const visibleBounds = this.getVisibleBounds()
    return toArray(this.options.parentContainer.children).filter((element) => {
      if (!isSnapElement(element)) return false
      if (selected.has(element.id)) return false
      if (
        visibleBounds &&
        !isElementInsideBounds(element as SnapTarget, this.app.tree, visibleBounds)
      ) {
        return false
      }
      return true
    })
  }

  private getVisibleBounds(): SnapBounds | null {
    const tree = this.app.tree
    const scale = Number(tree?.scale || 1)
    const width = Number(this.app.width || 0)
    const height = Number(this.app.height || 0)
    if (!tree || !scale || !width || !height) return null

    return {
      x: -Number(tree.x || 0) / scale,
      y: -Number(tree.y || 0) / scale,
      width: width / scale,
      height: height / scale,
    }
  }

  private applySnapOffset(target: SnapTarget, snap: {
    x: SnapCollision | null
    y: SnapCollision | null
  }) {
    const editor = this.app.editor
    const targets = editor?.list ?? []
    for (const target of targets) {
      this.applyAxisOffset(target as SnapTarget, 'x', snap.x)
      this.applyAxisOffset(target as SnapTarget, 'y', snap.y)
    }

    if (editor?.multiple && target.safeChange) {
      target.safeChange(() => {
        this.applyAxisOffset(target, 'x', snap.x)
        this.applyAxisOffset(target, 'y', snap.y)
      })
    }
  }

  private applyAxisOffset(
    target: SnapTarget,
    axis: 'x' | 'y',
    snap: SnapCollision | null
  ) {
    if (!snap || !snap.delta) return
    const scale = Number(this.options.parentContainer.scale || 1)
    target[axis] = Number(target[axis] || 0) + snap.delta / scale
  }

  private applyResizeSnap(
    target: SnapTarget,
    snap: SnapDeltas,
    targetBounds: SnapBounds | null,
    resizeSides: SnapResizeSides | null,
    worldOrigin: Point | null | undefined
  ) {
    if (this.app.editor?.multiple) return

    const scale = calculateResizeSnapScale({
      bounds: targetBounds,
      snap,
      resizeSides,
      lockRatio: isLockRatioTarget(target),
    })
    const origin =
      worldOrigin ?? getResizeWorldOrigin(this.app.tree, targetBounds, resizeSides)
    if (!scale || !origin) return

    target.scaleOfWorld(origin, scale.scaleX, scale.scaleY, true)
  }

  private renderGuides(
    snap: { x: SnapCollision | null; y: SnapCollision | null },
    collisions: SnapCollision[],
    targetPoints: SnapPoint[],
    targetBounds: SnapBounds | null
  ) {
    const segments = collisions
      .map((collision) => ({
        collision,
        segment: createGuideSegment(
          collision,
          targetPoints,
          this.getWorldPadding()
        ),
      }))
      .filter(
        (item): item is { collision: SnapCollision; segment: GuideSegment } =>
          Boolean(item.segment)
      )

    this.updateGuideLines(
      'vertical',
      segments
        .filter((item) => item.collision.axis === 'x')
        .map((item) => item.segment)
    )
    this.updateGuideLines(
      'horizontal',
      segments
        .filter((item) => item.collision.axis === 'y')
        .map((item) => item.segment)
    )

    const markerPoints = getCollisionPointsFromCollisions(collisions)
    const distanceGuides = calculateDistanceGuides({
      snap,
      targetPoints,
      labelOffset: this.getWorldLabelOffset(),
    })
    const equalSpacingGuides = targetBounds
      ? calculateEqualSpacingGuides({
          target: targetBounds,
          candidates: this.snapBounds,
        })
      : []
    this.updatePointMarkers(markerPoints)
    this.updateDistanceGuides(distanceGuides)
    this.updateEqualSpacingGuides(equalSpacingGuides)
  }

  private updateGuideLines(
    type: 'vertical' | 'horizontal',
    segments: GuideSegment[]
  ) {
    segments.forEach((segment, index) => {
      const line = this.getGuideLine(type, index)
      const [x1, y1, x2, y2] = segment
      const start = this.app.tree?.getWorldPoint({ x: x1, y: y1 })
      const end = this.app.tree?.getWorldPoint({ x: x2, y: y2 })
      if (!start || !end) {
        line.visible = false
        return
      }

      line.set({
        points: [start.x, start.y, end.x, end.y],
        visible: true,
      })
    })
    hideUnused(this.getGuideLineList(type), segments.length)
  }

  private getGuideLine(type: 'vertical' | 'horizontal', index: number) {
    const lines = this.getGuideLineList(type)
    let line = lines[index]
    if (!line) {
      line = new Line({
        stroke: this.options.lineColor,
        strokeWidth: this.options.strokeWidth,
        className: `canvas-snap-${type}`,
        visible: false,
        zIndex: 10000,
      })
      lines[index] = line
      this.app.sky?.add(line)
    }
    return line
  }

  private getGuideLineList(type: 'vertical' | 'horizontal') {
    return type === 'vertical' ? this.verticalLines : this.horizontalLines
  }

  private updatePointMarkers(points: SnapPoint[]) {
    points.forEach((point, index) => {
      const marker = this.getPointMarker(index)
      const worldPoint = this.app.tree?.getWorldPoint(point)
      if (!worldPoint) {
        marker.visible = false
        return
      }
      marker.set({
        x: worldPoint.x,
        y: worldPoint.y,
        visible: true,
      })
    })
    hideUnused(this.pointMarkers, points.length)
  }

  private getPointMarker(index: number) {
    let marker = this.pointMarkers[index]
    if (!marker) {
      const size = this.options.pointSize
      const half = size / 2
      marker = new Group({
        className: 'canvas-snap-point',
        visible: false,
        zIndex: 10001,
        children: [
          new Line({
            stroke: this.options.lineColor,
            strokeWidth: this.options.strokeWidth,
            points: [-half, -half, half, half],
          }),
          new Line({
            stroke: this.options.lineColor,
            strokeWidth: this.options.strokeWidth,
            points: [-half, half, half, -half],
          }),
        ],
      })
      this.pointMarkers[index] = marker
      this.app.sky?.add(marker)
    }
    return marker
  }

  private updateDistanceGuides(guides: SnapDistanceGuide[]) {
    guides.forEach((guide, index) => {
      this.updateDistanceLine(index, guide)
      this.updateDistanceLabel(index, guide)
    })
    hideUnused(this.distanceLines, guides.length)
    hideUnused(this.distanceLabels, guides.length)
  }

  private updateDistanceLine(index: number, guide: SnapDistanceGuide) {
    const line = this.getDistanceLine(index)
    const start = this.app.tree?.getWorldPoint(guide.start)
    const end = this.app.tree?.getWorldPoint(guide.end)
    if (!start || !end) {
      line.visible = false
      return
    }
    line.set({
      points: [start.x, start.y, end.x, end.y],
      visible: true,
    })
  }

  private getDistanceLine(index: number) {
    let line = this.distanceLines[index]
    if (!line) {
      line = new Line({
        stroke: this.options.lineColor,
        strokeWidth: this.options.strokeWidth,
        dashPattern: [4, 2],
        className: 'canvas-snap-distance-line',
        visible: false,
        zIndex: 10000,
      })
      this.distanceLines[index] = line
      this.app.sky?.add(line)
    }
    return line
  }

  private updateDistanceLabel(index: number, guide: SnapDistanceGuide) {
    const label = this.getDistanceLabel(index)
    const worldPoint = this.app.tree?.getWorldPoint(guide.position)
    if (!worldPoint) {
      label.visible = false
      return
    }

    const width = Math.max(18, guide.text.length * 7 + 8)
    const height = 16
    const text = label.children[0] as Text
    text.set({
      text: guide.text,
      x: 0,
      y: 0,
      width,
      height,
      visible: true,
    })
    label.set({
      x: worldPoint.x - width / 2,
      y: worldPoint.y - height / 2,
      width,
      height,
      visible: true,
    })
  }

  private getDistanceLabel(index: number) {
    let label = this.distanceLabels[index]
    if (!label) {
      label = new Box({
        fill: this.options.lineColor,
        cornerRadius: 3,
        className: 'canvas-snap-distance-label',
        visible: false,
        zIndex: 10002,
        children: [
          new Text({
            fill: '#FFFFFF',
            fontSize: 10,
            textAlign: 'center',
            verticalAlign: 'middle',
          }),
        ],
      })
      this.distanceLabels[index] = label
      this.app.sky?.add(label)
    }
    return label
  }

  private updateEqualSpacingGuides(guides: SnapEqualSpacingGuide[]) {
    guides.forEach((guide, index) => {
      const box = this.getEqualSpacingBox(index)
      const start = this.app.tree?.getWorldPoint({
        x: guide.box.x,
        y: guide.box.y,
      })
      const end = this.app.tree?.getWorldPoint({
        x: guide.box.x + guide.box.width,
        y: guide.box.y + guide.box.height,
      })
      if (!start || !end) {
        box.visible = false
        return
      }

      box.set({
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        visible: true,
      })
    })
    hideUnused(this.equalSpacingBoxes, guides.length)
  }

  private getEqualSpacingBox(index: number) {
    let box = this.equalSpacingBoxes[index]
    if (!box) {
      box = new Box({
        fill: this.options.lineColor,
        opacity: 0.16,
        className: 'canvas-snap-equal-spacing',
        visible: false,
        zIndex: 9999,
      })
      this.equalSpacingBoxes[index] = box
      this.app.sky?.add(box)
    }
    return box
  }

  private getWorldPadding() {
    return getWorldSnapThreshold(
      this.options.linePadding,
      this.app.tree?.scale as number
    )
  }

  private getWorldLabelOffset() {
    return getWorldSnapThreshold(
      this.options.labelOffset,
      this.app.tree?.scale as number
    )
  }

  private clearGuides() {
    this.verticalLines.forEach((line) => line.destroy())
    this.horizontalLines.forEach((line) => line.destroy())
    this.pointMarkers.forEach((marker) => marker.destroy())
    this.distanceLines.forEach((line) => line.destroy())
    this.distanceLabels.forEach((label) => label.destroy())
    this.equalSpacingBoxes.forEach((box) => box.destroy())
    this.verticalLines = []
    this.horizontalLines = []
    this.pointMarkers = []
    this.distanceLines = []
    this.distanceLabels = []
    this.equalSpacingBoxes = []
  }

  private handleKeyEvent = (event: KeyEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      return
    }
    this.isKeyboardMove = event.type === KeyEvent.DOWN
  }
}

type GuideSegment = [number, number, number, number]

function getElementSnapPoints(element: SnapTarget, relative: IUI): SnapPoint[] {
  const bounds = getElementSnapBounds(element, relative)
  return bounds ? createSnapPointsFromBounds(bounds, element.id) : []
}

function getScaleResizeSides(
  direction: number | undefined,
  bounds: SnapBounds | null,
  origin: Point | null | undefined
): SnapResizeSides {
  return {
    x:
      getResizeSide(direction, 'x') ??
      (bounds ? getResizeSideFromOrigin(bounds, origin, 'x') : null),
    y:
      getResizeSide(direction, 'y') ??
      (bounds ? getResizeSideFromOrigin(bounds, origin, 'y') : null),
  }
}

function getResizeWorldOrigin(
  tree: IUI,
  bounds: SnapBounds | null,
  resizeSides: SnapResizeSides | null
) {
  if (!bounds || !resizeSides) return null
  const localOrigin = {
    x: getResizeAxisOrigin(bounds, resizeSides.x, 'x'),
    y: getResizeAxisOrigin(bounds, resizeSides.y, 'y'),
  }

  return tree.getWorldPoint?.(localOrigin) ?? localOrigin
}

function getResizeAxisOrigin(
  bounds: SnapBounds,
  side: 'min' | 'max' | null,
  axis: 'x' | 'y'
) {
  const position = axis === 'x' ? bounds.x : bounds.y
  const size = axis === 'x' ? bounds.width : bounds.height
  if (side === 'min') return position + size
  if (side === 'max') return position
  return position + size / 2
}

function isLockRatioTarget(target: SnapTarget) {
  const data = target as SnapTarget & {
    __?: { lockRatio?: boolean }
    lockRatio?: boolean
  }
  return Boolean(data.lockRatio ?? data.__?.lockRatio)
}

function getScaleSnapPoints(points: SnapPoint[], resizeSides: SnapResizeSides | null) {
  const resizePoints = [
    ...getResizeSnapPoints(points, resizeSides?.x, 'x'),
    ...getResizeSnapPoints(points, resizeSides?.y, 'y'),
  ]
  return resizePoints.length ? resizePoints : points
}

function getLocalPoint(relative: IUI, point: Point | null | undefined) {
  if (!point) return null
  const converter = relative as IUI & {
    getInnerPoint?: (point: Point) => Point
  }
  try {
    return converter.getInnerPoint?.(point) ?? point
  } catch {
    return point
  }
}

function getElementSnapBounds(
  element: SnapTarget,
  relative: IUI
): SnapBounds | null {
  return createBoundsFromPoints(element.getLayoutPoints('box', relative))
}

function isElementInsideBounds(
  element: SnapTarget,
  relative: IUI,
  bounds: SnapBounds
) {
  const elementBounds = getElementSnapBounds(element, relative)
  return elementBounds ? boundsIntersect(elementBounds, bounds) : false
}

function createGuideSegment(
  collision: SnapCollision,
  targetPoints: SnapPoint[],
  padding: number
): GuideSegment | null {
  const axis = collision.axis
  const crossAxis = axis === 'x' ? 'y' : 'x'
  const value = collision.line.value
  const points = [
    ...collision.line.points,
    ...targetPoints.filter((point) => Math.abs(point[axis] - value) < 1),
  ]
  if (points.length < 2) return null

  const min = Math.min(...points.map((point) => point[crossAxis])) - padding
  const max = Math.max(...points.map((point) => point[crossAxis])) + padding

  return axis === 'x' ? [value, min, value, max] : [min, value, max, value]
}

function toArray(children: unknown): IUI[] {
  if (!children) return []
  if (Array.isArray(children)) return children as IUI[]
  return Array.from(children as Iterable<IUI>)
}

function isSnapElement(element: IUI) {
  if (!element || element.isLeafer) return false
  if (element.className !== 'Node') return false
  if (element.visible === false) return false
  if ((element as IUI & { isSnap?: boolean }).isSnap === false) return false
  return typeof (element as SnapTarget).getLayoutPoints === 'function'
}

function hideUnused(items: IUI[], usedCount: number) {
  for (let index = usedCount; index < items.length; index += 1) {
    items[index].visible = false
  }
}
