export type SnapAxis = 'x' | 'y'
export type SnapLineType = 'vertical' | 'horizontal'
export type SnapPointType =
  | 'tl'
  | 'tr'
  | 'bl'
  | 'br'
  | 'ml'
  | 'mr'
  | 'mt'
  | 'mb'

export interface SnapBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapPoint {
  x: number
  y: number
  type: SnapPointType
  elementId?: string
}

export interface SnapLine {
  type: SnapLineType
  axis: SnapAxis
  value: number
  points: SnapPoint[]
}

export interface SnapCollision {
  line: SnapLine
  axis: SnapAxis
  offset: number
  delta: number
  distance: number
  targetPoints: SnapPoint[]
}

export interface SnapDeltas {
  x: SnapCollision | null
  y: SnapCollision | null
}

export interface SnapResizeSides {
  x: SnapResizeSide | null
  y: SnapResizeSide | null
}

export interface SnapResizeScale {
  scaleX: number
  scaleY: number
}

export interface SnapDistanceGuide {
  axis: SnapAxis
  start: { x: number; y: number }
  end: { x: number; y: number }
  position: { x: number; y: number }
  distance: number
  text: string
}

export interface SnapEqualSpacingGuide {
  axis: SnapAxis
  spacing: number
  box: SnapBounds
}

export type SnapResizeSide = 'min' | 'max'

const MIN_ZOOM = 0.0001

export function getWorldSnapThreshold(
  screenThresholdPx: number,
  zoom: number | undefined
) {
  const safeZoom = Math.max(Math.abs(zoom || 1), MIN_ZOOM)
  return screenThresholdPx / safeZoom
}

export function createSnapPointsFromBounds(
  bounds: SnapBounds,
  elementId?: string
): SnapPoint[] {
  const minX = bounds.x
  const maxX = bounds.x + bounds.width
  const minY = bounds.y
  const maxY = bounds.y + bounds.height
  const centerX = minX + bounds.width / 2
  const centerY = minY + bounds.height / 2

  return [
    { x: minX, y: minY, type: 'tl', elementId },
    { x: maxX, y: minY, type: 'tr', elementId },
    { x: minX, y: maxY, type: 'bl', elementId },
    { x: maxX, y: maxY, type: 'br', elementId },
    { x: minX, y: centerY, type: 'ml', elementId },
    { x: maxX, y: centerY, type: 'mr', elementId },
    { x: centerX, y: minY, type: 'mt', elementId },
    { x: centerX, y: maxY, type: 'mb', elementId },
  ]
}

export function createBoundsFromPoints(
  points: Array<{ x: number; y: number }>
): SnapBounds | null {
  if (points.length < 2) return null
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)

  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

export function boundsIntersect(a: SnapBounds, b: SnapBounds) {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  )
}

export function createSnapLines(points: SnapPoint[]): SnapLine[] {
  const vertical = new Map<number, SnapPoint[]>()
  const horizontal = new Map<number, SnapPoint[]>()

  for (const point of points) {
    const xPoints = vertical.get(point.x) ?? []
    xPoints.push(point)
    vertical.set(point.x, xPoints)

    const yPoints = horizontal.get(point.y) ?? []
    yPoints.push(point)
    horizontal.set(point.y, yPoints)
  }

  return [
    ...[...vertical.entries()].map(([value, linePoints]) => ({
      type: 'vertical' as const,
      axis: 'x' as const,
      value,
      points: linePoints.sort((a, b) => a.y - b.y),
    })),
    ...[...horizontal.entries()].map(([value, linePoints]) => ({
      type: 'horizontal' as const,
      axis: 'y' as const,
      value,
      points: linePoints.sort((a, b) => a.x - b.x),
    })),
  ]
}

export function resolveSnapDeltas({
  targetPoints,
  snapLines,
  threshold,
}: {
  targetPoints: SnapPoint[]
  snapLines: SnapLine[]
  threshold: number
}): SnapDeltas {
  return {
    x: selectBestCollision(targetPoints, snapLines, 'x', threshold),
    y: selectBestCollision(targetPoints, snapLines, 'y', threshold),
  }
}

export function resolveSnapCollisions({
  targetPoints,
  snapLines,
  threshold,
}: {
  targetPoints: SnapPoint[]
  snapLines: SnapLine[]
  threshold: number
}): SnapCollision[] {
  const collisions: SnapCollision[] = []

  for (const line of snapLines) {
    const targetMatches: SnapPoint[] = []
    let nearestOffset = 0
    let nearestDistance = Infinity

    for (const point of targetPoints) {
      const offset = point[line.axis] - line.value
      const distance = Math.abs(offset)
      if (distance > threshold) continue
      targetMatches.push(point)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestOffset = offset
      }
    }

    if (!targetMatches.length) continue

    collisions.push({
      line,
      axis: line.axis,
      offset: nearestOffset,
      delta: -nearestOffset,
      distance: nearestDistance,
      targetPoints: targetMatches,
    })
  }

  return collisions.sort((a, b) => a.distance - b.distance)
}

export function calculateDistanceGuides({
  snap,
  targetPoints,
  labelOffset = 0,
}: {
  snap: SnapDeltas
  targetPoints: SnapPoint[]
  labelOffset?: number
}): SnapDistanceGuide[] {
  return [
    ...calculateAxisDistanceGuides(snap.x, targetPoints, labelOffset),
    ...calculateAxisDistanceGuides(snap.y, targetPoints, labelOffset),
  ]
}

export function calculateEqualSpacingGuides({
  target,
  candidates,
  tolerance = 1,
}: {
  target: SnapBounds
  candidates: SnapBounds[]
  tolerance?: number
}): SnapEqualSpacingGuide[] {
  return [
    ...calculateAxisEqualSpacingGuides('x', target, candidates, tolerance),
    ...calculateAxisEqualSpacingGuides('y', target, candidates, tolerance),
  ]
}

export function getCollisionPoints(snap: SnapDeltas): SnapPoint[] {
  const points: SnapPoint[] = []
  for (const collision of [snap.x, snap.y]) {
    if (!collision) continue
    points.push(...collision.line.points, ...collision.targetPoints)
  }

  return uniqueSnapPoints(points)
}

export function getCollisionPointsFromCollisions(collisions: SnapCollision[]) {
  return uniqueSnapPoints(
    collisions.flatMap((collision) => [
      ...collision.line.points,
      ...collision.targetPoints,
    ])
  )
}

export function getResizeSide(
  direction: number | undefined,
  axis: SnapAxis
): SnapResizeSide | null {
  if (direction === undefined) return null

  if (axis === 'x') {
    if ([0, 6, 7].includes(direction)) return 'min'
    if ([2, 3, 4].includes(direction)) return 'max'
    return null
  }

  if ([0, 1, 2].includes(direction)) return 'min'
  if ([4, 5, 6].includes(direction)) return 'max'
  return null
}

export function getResizeSideFromOrigin(
  bounds: SnapBounds,
  origin: { x: number; y: number } | null | undefined,
  axis: SnapAxis,
  tolerance = 1
): SnapResizeSide | null {
  if (!origin) return null

  const start = getAxisStart(axis, bounds)
  const end = getAxisEnd(axis, bounds)
  const value = origin[axis]
  if (Math.abs(value - start) <= tolerance) return 'max'
  if (Math.abs(value - end) <= tolerance) return 'min'
  return null
}

export function getResizeSnapPoints(
  points: SnapPoint[],
  directionOrSide: number | SnapResizeSide | null | undefined,
  axis: SnapAxis
) {
  const side =
    typeof directionOrSide === 'string'
      ? directionOrSide
      : getResizeSide(directionOrSide ?? undefined, axis)
  if (!side) return []
  return points.filter((point) =>
    side === 'min'
      ? isMinResizePoint(point.type, axis)
      : isMaxResizePoint(point.type, axis)
  )
}

export function calculateResizeSnapScale({
  bounds,
  snap,
  resizeSides,
  lockRatio = false,
}: {
  bounds: SnapBounds | null
  snap: SnapDeltas
  resizeSides: SnapResizeSides | null
  lockRatio?: boolean
}): SnapResizeScale | null {
  if (!bounds || !resizeSides) return null

  const x = getAxisResizeScale(bounds.width, snap.x, resizeSides.x)
  const y = getAxisResizeScale(bounds.height, snap.y, resizeSides.y)
  if (!x && !y) return null

  if (lockRatio) {
    const primary = chooseLockRatioScale(x, y)
    return primary ? { scaleX: primary.scale, scaleY: primary.scale } : null
  }

  return {
    scaleX: x?.scale ?? 1,
    scaleY: y?.scale ?? 1,
  }
}

function calculateAxisEqualSpacingGuides(
  axis: SnapAxis,
  target: SnapBounds,
  candidates: SnapBounds[],
  tolerance: number
): SnapEqualSpacingGuide[] {
  const entries = [
    { bounds: target, isTarget: true },
    ...candidates.map((bounds) => ({ bounds, isTarget: false })),
  ]
    .filter(
      (entry) =>
        entry.isTarget || boundsOverlapOnCrossAxis(axis, entry.bounds, target)
    )
    .sort((a, b) => getAxisStart(axis, a.bounds) - getAxisStart(axis, b.bounds))

  const targetIndex = entries.findIndex((entry) => entry.isTarget)
  if (targetIndex < 0 || entries.length < 3) return []

  const gaps = entries.flatMap((entry, index) => {
    const next = entries[index + 1]
    if (!next) return []

    const spacing = getAxisStart(axis, next.bounds) - getAxisEnd(axis, entry.bounds)
    if (spacing <= 0) return []

    const box = createSpacingBox(axis, entry.bounds, next.bounds, spacing)
    if (!box) return []

    return [
      {
        startIndex: index,
        endIndex: index + 1,
        spacing,
        box,
      },
    ]
  })

  const equalGaps = new Map<string, SnapEqualSpacingGuide>()
  for (const gap of gaps) {
    if (gap.startIndex !== targetIndex && gap.endIndex !== targetIndex) continue

    const matches = gaps.filter(
      (candidate) => Math.abs(candidate.spacing - gap.spacing) <= tolerance
    )
    if (matches.length < 2) continue

    for (const match of matches) {
      const key = `${axis}:${Math.round(match.box.x * 100) / 100}:${
        Math.round(match.box.y * 100) / 100
      }:${Math.round(match.box.width * 100) / 100}:${
        Math.round(match.box.height * 100) / 100
      }`
      equalGaps.set(key, {
        axis,
        spacing: Math.round(match.spacing),
        box: match.box,
      })
    }
  }

  return [...equalGaps.values()]
}

function boundsOverlapOnCrossAxis(
  axis: SnapAxis,
  a: SnapBounds,
  b: SnapBounds
) {
  const crossAxis = axis === 'x' ? 'y' : 'x'
  return (
    getAxisStart(crossAxis, a) < getAxisEnd(crossAxis, b) &&
    getAxisEnd(crossAxis, a) > getAxisStart(crossAxis, b)
  )
}

function createSpacingBox(
  axis: SnapAxis,
  previous: SnapBounds,
  next: SnapBounds,
  spacing: number
): SnapBounds | null {
  const crossAxis = axis === 'x' ? 'y' : 'x'
  const crossStart = Math.max(
    getAxisStart(crossAxis, previous),
    getAxisStart(crossAxis, next)
  )
  const crossEnd = Math.min(
    getAxisEnd(crossAxis, previous),
    getAxisEnd(crossAxis, next)
  )
  const crossSize = crossEnd - crossStart
  if (crossSize <= 0) return null

  return axis === 'x'
    ? {
        x: getAxisEnd('x', previous),
        y: crossStart,
        width: spacing,
        height: crossSize,
      }
    : {
        x: crossStart,
        y: getAxisEnd('y', previous),
        width: crossSize,
        height: spacing,
      }
}

function getAxisStart(axis: SnapAxis, bounds: SnapBounds) {
  return axis === 'x' ? bounds.x : bounds.y
}

function getAxisEnd(axis: SnapAxis, bounds: SnapBounds) {
  return getAxisStart(axis, bounds) + (axis === 'x' ? bounds.width : bounds.height)
}

function getAxisResizeScale(
  size: number,
  collision: SnapCollision | null,
  side: SnapResizeSide | null
) {
  if (!collision || !collision.delta || !side || size <= 0) return null

  const nextSize =
    side === 'min' ? size - collision.delta : size + collision.delta
  if (!Number.isFinite(nextSize) || nextSize < 1) return null

  return {
    scale: nextSize / size,
    delta: Math.abs(collision.delta),
  }
}

function chooseLockRatioScale(
  x: { scale: number; delta: number } | null,
  y: { scale: number; delta: number } | null
) {
  if (!x) return y
  if (!y) return x
  return x.delta <= y.delta ? x : y
}

function selectBestCollision(
  targetPoints: SnapPoint[],
  snapLines: SnapLine[],
  axis: SnapAxis,
  threshold: number
): SnapCollision | null {
  return (
    resolveSnapCollisions({ targetPoints, snapLines, threshold }).find(
      (collision) => collision.axis === axis
    ) ?? null
  )
}

function calculateAxisDistanceGuides(
  collision: SnapCollision | null,
  targetPoints: SnapPoint[],
  labelOffset: number
): SnapDistanceGuide[] {
  if (!collision) return []

  if (collision.axis === 'x') {
    return selectNearestDistanceGuides({
      axis: 'x',
      candidates: collision.line.points.filter(
        (point) => !['ml', 'mr'].includes(point.type)
      ),
      primaryEdge: getRequiredPoint(targetPoints, 'mt'),
      secondaryEdge: getRequiredPoint(targetPoints, 'mb'),
      createEnd: (edge, point) => ({ x: edge.x, y: point.y }),
      offsetPosition: (mid) => ({ x: mid.x + labelOffset, y: mid.y }),
    })
  }

  return selectNearestDistanceGuides({
    axis: 'y',
    candidates: collision.line.points.filter(
      (point) => !['mt', 'mb'].includes(point.type)
    ),
    primaryEdge: getRequiredPoint(targetPoints, 'ml'),
    secondaryEdge: getRequiredPoint(targetPoints, 'mr'),
    createEnd: (edge, point) => ({ x: point.x, y: edge.y }),
    offsetPosition: (mid) => ({ x: mid.x, y: mid.y + labelOffset }),
  })
}

function selectNearestDistanceGuides({
  axis,
  candidates,
  primaryEdge,
  secondaryEdge,
  createEnd,
  offsetPosition,
}: {
  axis: SnapAxis
  candidates: SnapPoint[]
  primaryEdge: SnapPoint
  secondaryEdge: SnapPoint
  createEnd: (
    edge: SnapPoint,
    point: SnapPoint
  ) => { x: number; y: number }
  offsetPosition: (point: { x: number; y: number }) => {
    x: number
    y: number
  }
}): SnapDistanceGuide[] {
  const coord = axis === 'x' ? 'y' : 'x'
  const primary = findNearestOnSide(candidates, primaryEdge[coord], coord, -1)
  const secondary = findNearestOnSide(
    candidates,
    secondaryEdge[coord],
    coord,
    1
  )
  const guides = [
    primary && createDistanceGuide(axis, primaryEdge, primary, createEnd, offsetPosition),
    secondary &&
      createDistanceGuide(axis, secondaryEdge, secondary, createEnd, offsetPosition),
  ].filter((guide): guide is SnapDistanceGuide => Boolean(guide))

  if (guides.length <= 1) return guides
  if (guides[0].distance === guides[1].distance) return guides
  return guides[0].distance < guides[1].distance ? [guides[0]] : [guides[1]]
}

function findNearestOnSide(
  points: SnapPoint[],
  origin: number,
  coord: 'x' | 'y',
  direction: -1 | 1
) {
  let best: SnapPoint | null = null
  let bestDistance = Infinity

  for (const point of points) {
    const delta = point[coord] - origin
    if (direction < 0 && delta >= 0) continue
    if (direction > 0 && delta <= 0) continue
    const distance = Math.abs(delta)
    if (distance < bestDistance) {
      best = point
      bestDistance = distance
    }
  }

  return best
}

function createDistanceGuide(
  axis: SnapAxis,
  start: SnapPoint,
  nearest: SnapPoint,
  createEnd: (
    edge: SnapPoint,
    point: SnapPoint
  ) => { x: number; y: number },
  offsetPosition: (point: { x: number; y: number }) => { x: number; y: number }
): SnapDistanceGuide {
  const end = createEnd(start, nearest)
  const mid = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  }
  const distance = Math.round(
    axis === 'x' ? Math.abs(start.y - end.y) : Math.abs(start.x - end.x)
  )

  return {
    axis,
    start,
    end,
    position: offsetPosition(mid),
    distance,
    text: String(distance),
  }
}

function getRequiredPoint(points: SnapPoint[], type: SnapPointType): SnapPoint {
  const point = points.find((item) => item.type === type)
  if (!point) throw new Error(`Missing snap point: ${type}`)
  return point
}

function isMinResizePoint(type: SnapPointType, axis: SnapAxis) {
  return axis === 'x'
    ? ['tl', 'ml', 'bl'].includes(type)
    : ['tl', 'mt', 'tr'].includes(type)
}

function isMaxResizePoint(type: SnapPointType, axis: SnapAxis) {
  return axis === 'x'
    ? ['tr', 'mr', 'br'].includes(type)
    : ['bl', 'mb', 'br'].includes(type)
}

function uniqueSnapPoints(points: SnapPoint[]) {
  const seen = new Set<string>()
  return points.filter((point) => {
    const key = `${Math.round(point.x * 100) / 100}:${Math.round(point.y * 100) / 100}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
