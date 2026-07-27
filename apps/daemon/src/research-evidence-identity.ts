export interface CanonicalResearchEvidenceIdentity {
  readonly canonicalUrl: string;
  readonly canonicalTextChecksum: string;
}

export function countCanonicalResearchEvidenceComponents(
  identities: readonly CanonicalResearchEvidenceIdentity[],
): number {
  const parents = identities.map((_identity, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const parent = parents[index]!;
      parents[index] = root;
      index = parent;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  for (let left = 0; left < identities.length; left += 1) {
    for (let right = 0; right < left; right += 1) {
      if (identities[left]!.canonicalUrl === identities[right]!.canonicalUrl
        || identities[left]!.canonicalTextChecksum === identities[right]!.canonicalTextChecksum) {
        union(left, right);
      }
    }
  }
  return new Set(identities.map((_identity, index) => find(index))).size;
}
