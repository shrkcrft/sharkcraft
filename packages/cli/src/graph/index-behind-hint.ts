import { detectGraphFreshness } from '@shrkcrft/graph';

/**
 * A "the index is N files behind" qualifier for a not-found / empty result, so
 * an agent doesn't read a bare "not-found" as "this symbol doesn't exist / is
 * safe to create" when the truth is "it's in a file the index hasn't seen yet."
 *
 * Runs the full freshness walk (`detectGraphFreshness`, the one freshness
 * authority) — only call it on the rare miss path. Shared by the code-graph
 * query verbs and `shrk reuse`.
 */
export function indexBehindHint(cwd: string): string | null {
  const f = detectGraphFreshness(cwd);
  if (!f.hasIndex) return null;
  const behind = f.modified.length + f.added.length + f.deleted.length;
  const pkgs = f.packagesChanged;
  if (behind === 0 && pkgs.length === 0) return null;
  const files = `${behind} file(s) (${f.modified.length} modified, ${f.added.length} new, ${f.deleted.length} deleted)`;
  if (pkgs.length === 0) {
    return `Index is ${behind} file(s) behind (${f.modified.length} modified, ${f.added.length} new, ${f.deleted.length} deleted) — run \`shrk graph index --changed\` and retry.`;
  }
  // A package.json entry edit changes what a bare import resolves to; only a
  // full index re-resolves the imports of unchanged files.
  const shown = pkgs.slice(0, 3).join(', ') + (pkgs.length > 3 ? `, +${pkgs.length - 3} more` : '');
  return `Index is behind: ${behind > 0 ? `${files} and ` : ''}${pkgs.length} workspace package(s) changed (${shown}) — run \`shrk graph index\` and retry.`;
}
