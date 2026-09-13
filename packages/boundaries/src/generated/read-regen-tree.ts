import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IMatchedFiles } from '../util/matched-files.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import { UnreadFileReason } from '../util/unread-file-reason.ts';
import { MAX_REGEN_FILE_BYTES } from '../util/walk-files.ts';

/**
 * Read a REGENERATED temp tree (what a `generatedArtifacts[].regen` wrote into
 * `{TMP}`): every file under `root`, keyed by POSIX path relative to it.
 *
 * Same contract as the one reader (`readMatchingFiles`): a file it did not read
 * (over {@link MAX_REGEN_FILE_BYTES}, or unreadable) is returned in `unread`
 * with its reason, never dropped. It used to be dropped, so a regen that wrote
 * a NEW 2.1MB file read "byte-identical to a fresh regen ✓" while the same
 * file at 100 bytes failed as "regen produces it but it is not committed".
 * The caller decides what an unread output means: one keyed onto a committed
 * file cannot be byte-compared (a coverage gap), one keyed onto nothing
 * committed is drift its path alone proves.
 */
export function readRegenTree(root: string): IMatchedFiles {
  const files = new Map<string, string>();
  const unread: IUnreadFile[] = [];
  const visit = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = nodePath.join(abs, e.name);
      if (e.isDirectory()) {
        visit(child);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = nodePath.relative(root, child).split(nodePath.sep).join('/');
      let size: number;
      try {
        size = statSync(child).size;
      } catch {
        unread.push({ path: rel, reason: UnreadFileReason.Unreadable });
        continue;
      }
      if (size > MAX_REGEN_FILE_BYTES) {
        unread.push({ path: rel, reason: UnreadFileReason.OverRegenCap, bytes: size });
        continue;
      }
      try {
        files.set(rel, readFileSync(child, 'utf8'));
      } catch {
        unread.push({ path: rel, reason: UnreadFileReason.Unreadable, bytes: size });
      }
    }
  };
  visit(root);
  unread.sort((a, b) => a.path.localeCompare(b.path));
  return { files, unread: Object.freeze(unread) };
}
