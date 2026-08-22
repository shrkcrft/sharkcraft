/**
 * Compare a committed generated tree against a freshly regenerated one.
 *
 * The comparison is deliberately SYMMETRIC. A regen that writes a subset (a
 * template dropped, an input renamed) leaves stale committed files behind, and
 * a one-directional check would report that as clean — the same one-way blind
 * spot that makes hand-rolled drift tests untrustworthy.
 */

/** One file that differs between the committed tree and the regenerated one. */
export interface IGeneratedFileDiff {
  readonly file: string;
  /**
   * `content` — present on both sides, bytes differ (the hand-edit signal).
   * `only-committed` — regen no longer produces it (stale committed file).
   * `only-regenerated` — regen produces it but it was never committed.
   */
  readonly kind: 'content' | 'only-committed' | 'only-regenerated';
}

export interface IGeneratedTreeDiff {
  readonly differences: readonly IGeneratedFileDiff[];
  readonly committedCount: number;
  readonly regeneratedCount: number;
}

/** Normalize line endings + trailing whitespace, and drop a trailing newline. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** Compare two path→content maps. Pure — the caller does all the IO. */
export function compareGeneratedTrees(
  committed: ReadonlyMap<string, string>,
  regenerated: ReadonlyMap<string, string>,
  compare: 'bytes' | 'normalized-whitespace' = 'bytes',
): IGeneratedTreeDiff {
  const norm = (s: string): string => (compare === 'bytes' ? s : normalizeWhitespace(s));
  const differences: IGeneratedFileDiff[] = [];
  for (const file of [...committed.keys()].sort()) {
    const regen = regenerated.get(file);
    if (regen === undefined) {
      differences.push({ file, kind: 'only-committed' });
      continue;
    }
    if (norm(committed.get(file)!) !== norm(regen)) {
      differences.push({ file, kind: 'content' });
    }
  }
  for (const file of [...regenerated.keys()].sort()) {
    if (!committed.has(file)) differences.push({ file, kind: 'only-regenerated' });
  }
  return {
    differences,
    committedCount: committed.size,
    regeneratedCount: regenerated.size,
  };
}
