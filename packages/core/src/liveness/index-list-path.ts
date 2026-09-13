/**
 * A spec list path with its `[i]` placeholders filled, in order —
 * `indexListPath('taskHints[i].boostIds', 2)` → `taskHints[2].boostIds`. The
 * loader (normalising) and the reporter (observing) both build the path through
 * this, so a mark and its observation cannot disagree about the index syntax.
 */
export function indexListPath(listPath: string, ...indices: readonly number[]): string {
  let next = 0;
  return listPath.replace(/\[i\]/g, (placeholder) => {
    const index = indices[next];
    next += 1;
    return index === undefined ? placeholder : `[${index}]`;
  });
}
