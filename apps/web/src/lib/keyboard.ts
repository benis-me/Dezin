export interface CompositionEventLike {
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}

export function isImeComposing(event: CompositionEventLike): boolean {
  return event.isComposing === true || event.nativeEvent?.isComposing === true;
}

const INTERACTIVE_ROLE_SELECTOR = [
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='switch']",
  "[role='tab']",
  "[role='treeitem']",
].join(",");

export function isReservedShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      `input,textarea,select,button,a,[contenteditable]:not([contenteditable='false']),[data-shortcuts-reserved],${INTERACTIVE_ROLE_SELECTOR}`,
    ),
  );
}
