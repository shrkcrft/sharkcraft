/**
 * THE hint for a reference whose path is missing (round 15 closing, A3) — the
 * stale-check row's `suggestion`, and through it the gate violation's hint,
 * the fix preview's draft and the MCP report. It branches on who can fix the
 * reference:
 *
 *   - a pack's reference is fixed in the pack: a `root: pack` path missing
 *     from the pack is shipped (or fixed) there; a project-rooted path the pack
 *     DOES ship names `root: pack`;
 *   - a Markdown entry's reference is edited in its `references:` frontmatter —
 *     `shrk fix --knowledge-stale --apply`, which lands a `shrk knowledge
 *     rename-file` plan, edits TypeScript entries only;
 *   - anything else gets the restore-or-rename hint.
 *
 * It used to be three string forks — the generic hint set where the path was
 * checked, two pack overrides layered on after — and a Markdown entry was told
 * to preview a rename that `--apply` then refuses to land.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { KnowledgeSourceFormat } from '@shrkcrft/knowledge';
import type { IStalePathHintInput } from './i-stale-path-hint-input.ts';
import { knowledgeRenameCommand } from './knowledge-rename-command.ts';
import { KnowledgeRenameVerb } from './knowledge-rename-verb.ts';

export function stalePathHint(h: IStalePathHintInput): string | undefined {
  if (h.pack !== undefined) {
    if (h.packRooted) {
      return `The path is missing from pack ${h.pack.packageName} (${h.pack.displayRoot}) — ship the file, or fix the reference, in the pack.`;
    }
    return existsSync(nodePath.join(h.pack.packageRoot, h.path))
      ? `${h.path} is shipped inside pack ${h.pack.packageName} (${h.pack.displayRoot}/${h.path}), but a pack's path resolves against the consuming project's root — declare root: pack on this reference, in the pack, to resolve it against the pack's directory.`
      : `A pack's path resolves against the consuming project's root, not against pack ${h.pack.packageName}'s directory — declare root: pack for a file the pack ships; fix the reference in the pack.`;
  }
  const what = h.kind === 'directory' ? 'directory' : 'file';
  if (h.sourceFormat === KnowledgeSourceFormat.Markdown) {
    return (
      `Restore the ${what}, or edit this reference's path in the references: frontmatter of ${h.source ?? 'its Markdown file'} — ` +
      '`shrk fix --knowledge-stale --apply` (which lands a `shrk knowledge rename-file` plan) edits TypeScript entries only.'
    );
  }
  // `rename-file` is a read-only preview already — it takes no `--dry-run`,
  // and the dispatcher refuses the flag (round 15 follow-up, F4). Built by THE
  // rename-command helper, the missing path filled in (lane B, B1).
  if (h.kind === 'file') {
    return `Restore the file, or preview the rename with \`${knowledgeRenameCommand(KnowledgeRenameVerb.RenameFile, h.path)}\`.`;
  }
  if (h.kind === 'directory') return 'Move the directory or update the knowledge reference.';
  return undefined;
}
