/**
 * A one-shot hand-off for prefilling the Home composer — set by "Generate with
 * this design system" (remix) and the template gallery, consumed by HomeScreen on
 * mount. Kept out of the URL so briefs with newlines/quotes stay intact.
 */
export interface PendingComposer {
  brief?: string;
  skillId?: string;
  designSystemId?: string;
}

let pending: PendingComposer | null = null;

export function setPendingComposer(value: PendingComposer): void {
  pending = value;
}

export function takePendingComposer(): PendingComposer | null {
  const v = pending;
  pending = null;
  return v;
}
