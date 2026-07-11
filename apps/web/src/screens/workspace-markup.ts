export interface MarkupRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MarkupStyles {
  display?: string;
  position?: string;
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
  zIndex?: string;
  width?: string;
  height?: string;
  minWidth?: string;
  maxWidth?: string;
  minHeight?: string;
  maxHeight?: string;
  overflow?: string;
  overflowX?: string;
  overflowY?: string;
  flexDirection?: string;
  flexWrap?: string;
  justifyContent?: string;
  alignItems?: string;
  alignContent?: string;
  gap?: string;
  rowGap?: string;
  columnGap?: string;
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  padding?: string;
  margin?: string;
  color?: string;
  background?: string;
  backgroundImage?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
  textAlign?: string;
  textTransform?: string;
  borderRadius?: string;
  opacity?: string;
  borderColor?: string;
  borderWidth?: string;
  borderStyle?: string;
  borderTopColor?: string;
  borderTopWidth?: string;
  borderTopStyle?: string;
  borderRightColor?: string;
  borderRightWidth?: string;
  borderRightStyle?: string;
  borderBottomColor?: string;
  borderBottomWidth?: string;
  borderBottomStyle?: string;
  borderLeftColor?: string;
  borderLeftWidth?: string;
  borderLeftStyle?: string;
  outlineColor?: string;
  outlineWidth?: string;
  outlineStyle?: string;
  boxShadow?: string;
  filter?: string;
  backdropFilter?: string;
  transform?: string;
  mixBlendMode?: string;
}

export interface MarkupAttributes {
  id?: string;
  className?: string;
  role?: string;
  ariaLabel?: string;
  screenLabel?: string;
  href?: string;
  src?: string;
}

export interface MarkupTarget {
  selector: string;
  tag: string;
  text: string;
  rect?: MarkupRect;
  note?: string;
  styles?: MarkupStyles;
  attrs?: MarkupAttributes;
}

const IMG_REF_RE = /\.refs\/[^\s,"'`)]+\.(?:png|jpe?g|gif|webp|svg|avif)/gi;
const RECT_RE = /x=(-?\d+)\s+y=(-?\d+)\s+w=(\d+)\s+h=(\d+)/;

function unquote(value: string): string {
  return value.trim().replace(/^["“`]+|["”`]+$/g, "");
}

export function parseMarkupTargets(block: string): MarkupTarget[] {
  const targets: MarkupTarget[] = [];
  let currentIndex = -1;
  const start = (selector: string): MarkupTarget => {
    const target = { selector, tag: "", text: "" };
    targets.push(target);
    currentIndex = targets.length - 1;
    return target;
  };
  for (const line of block.split("\n")) {
    const modern = line.match(/^\s*-\s*selector:\s*`([^`]+)`/);
    if (modern) {
      start(modern[1]!.trim());
      continue;
    }
    const legacy = line.match(/^\s*-\s*`([^`]+)`(?:\s+\(“([^”]*)”\))?(?::\s*(.*))?/);
    if (legacy) {
      const target = start(legacy[1]!.trim());
      target.text = legacy[2]?.trim() ?? "";
      target.note = legacy[3]?.trim() || undefined;
      continue;
    }
    const target = targets[currentIndex];
    if (!target) continue;
    const attr = line.match(/^\s*(tag|rect|text|note):\s*(.*)$/);
    if (!attr) continue;
    const [, key, raw = ""] = attr;
    if (key === "tag") target.tag = unquote(raw);
    else if (key === "text") target.text = unquote(raw);
    else if (key === "note") target.note = unquote(raw) || undefined;
    else if (key === "rect") {
      const match = raw.match(RECT_RE);
      if (match) target.rect = { x: Number(match[1]), y: Number(match[2]), w: Number(match[3]), h: Number(match[4]) };
    }
  }
  return targets;
}

/** Split a user message into its prose and any attached image refs, dropping the
 *  auto-generated "(read them from disk): …" reference lines from the visible text. */
export function parseUserMessage(text: string): { body: string; images: string[]; targets: MarkupTarget[] } {
  const images = [...new Set(text.match(IMG_REF_RE) ?? [])];
  const targets: MarkupTarget[] = [];
  const bodyParts: string[] = [];
  for (const part of text.split(/\n{2,}/)) {
    if (/read them from disk/i.test(part)) continue;
    if (/^Scoped edit\s+—/i.test(part.trim())) {
      targets.push(...parseMarkupTargets(part));
      continue;
    }
    bodyParts.push(part);
  }
  return { body: bodyParts.join("\n\n").trim(), images, targets };
}

function quoteMarkupValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatMarkupTarget(target: MarkupTarget): string {
  const lines = [`- selector: \`${target.selector}\``];
  if (target.tag) lines.push(`  tag: ${target.tag}`);
  if (target.rect) lines.push(`  rect: x=${target.rect.x} y=${target.rect.y} w=${target.rect.w} h=${target.rect.h}`);
  if (target.text) lines.push(`  text: ${quoteMarkupValue(target.text)}`);
  if (target.note) lines.push(`  note: ${target.note}`);
  return lines.join("\n");
}

export const MARKUP_POPOVER = { width: 288, height: 192, margin: 12, gap: 8 };

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function computeMarkupPosition(
  iframeRect: { left: number; top: number; width: number; height: number } | null | undefined,
  elementRect: { x: number; y: number; w: number; h: number } | null | undefined,
  viewport: { width: number; height: number },
  popover: { width: number; height: number; margin?: number; gap?: number } = MARKUP_POPOVER,
): { x: number; y: number } {
  const margin = popover.margin ?? MARKUP_POPOVER.margin;
  const gap = popover.gap ?? MARKUP_POPOVER.gap;
  const maxX = Math.max(margin, viewport.width - popover.width - margin);
  const maxY = Math.max(margin, viewport.height - popover.height - margin);
  if (!iframeRect || !elementRect) return { x: maxX, y: Math.min(120, maxY) };

  const anchorX = iframeRect.left + elementRect.x;
  const belowY = iframeRect.top + elementRect.y + elementRect.h + gap;
  const aboveY = iframeRect.top + elementRect.y - popover.height - gap;
  const y = belowY <= maxY ? belowY : aboveY >= margin ? clamp(aboveY, margin, maxY) : clamp(belowY, margin, maxY);

  return {
    x: clamp(anchorX, margin, maxX),
    y,
  };
}
