/**
 * Per-variation brief framing for scoped-variant fan-out (impeccable's "variation within
 * identity, not selection between identities"). Each variation gets the same base brief plus
 * an instruction to explore a DISTINCT take while preserving the brand identity — so the N
 * variations diverge in composition, not in brand.
 */
export function composeVariationBrief(baseBrief: string, index: number, count: number): string {
  return (
    `${baseBrief}\n\n` +
    `This is variation ${index + 1} of ${count} — explore a genuinely distinct take. ` +
    `Preserve the brand identity: palette, type system, spacing scale, and voice stay the same. ` +
    `Vary the composition, emphasis, or treatment, not the identity. ` +
    `Do not converge on the same layout as the other variations.`
  );
}
