import type { IVerdictCoverage } from '@shrkcrft/core';
import { globCoversAllUnder, globListParts, globListSelects, globMayMatchUnder } from '../scan/glob.ts';
import type { IMatchedFiles } from './matched-files.ts';
import type { IReadScope } from './read-scope.ts';
import type { IUnreadFile } from './unread-file.ts';
import { UnreadFileReason } from './unread-file-reason.ts';
import { MAX_REGEN_FILE_BYTES, MAX_SCAN_FILE_BYTES } from './walk-files.ts';

/** At most this many unread paths ride on one coverage record. */
const UNREAD_LABEL_CAP = 20;

/** How a coverage gap names a file the reader skipped for its size. */
export const READ_CAP_REASON = `over the ${MAX_SCAN_FILE_BYTES / 1_000_000}MB read cap`;

/** How a coverage gap names a regenerated file skipped for its size. */
export const REGEN_CAP_REASON = `over the ${MAX_REGEN_FILE_BYTES / 1_000_000}MB regen read cap`;

/** How a coverage gap names a directory the walk could not list. */
export const UNLISTABLE_DIR_REASON = 'unlistable (a directory whose files were never enumerated)';

/** The one sentence naming why a set of files went unread. */
export function unreadReason(unread: readonly IUnreadFile[]): string {
  const kinds = new Set(unread.map((u) => u.reason));
  const parts = [
    ...(kinds.has(UnreadFileReason.OverReadCap) ? [READ_CAP_REASON] : []),
    ...(kinds.has(UnreadFileReason.OverRegenCap) ? [REGEN_CAP_REASON] : []),
    ...(kinds.has(UnreadFileReason.Unreadable) ? ['unreadable'] : []),
    ...(kinds.has(UnreadFileReason.UnreadableDirectory) ? [UNLISTABLE_DIR_REASON] : []),
  ];
  return parts.length > 0 ? parts.join(' or ') : READ_CAP_REASON;
}

/** True for the entry of a directory the walk could not list (its path ends in `/`). */
export function isUnreadDirectory(u: IUnreadFile): boolean {
  return u.reason === UnreadFileReason.UnreadableDirectory;
}

/** Is project-relative `path` beneath the unlistable-directory entry `u`? */
export function unreadDirectoryContains(u: IUnreadFile, path: string): boolean {
  return isUnreadDirectory(u) && (u.path === './' || path.startsWith(u.path));
}

/**
 * THE "is this unread entry in front of these globs?" test, for every plane.
 * A file: the list SELECTS its path (`globListSelects` — an inclusion glob
 * matches, no negation does). A directory the walk could not list: an
 * inclusion glob could match something beneath it (`globMayMatchUnder`) and no
 * negation covers ALL of it (`globCoversAllUnder`) — its files were never
 * enumerated, so no rule over that tree may claim it examined them, unless the
 * list itself excludes every one of them.
 */
export function unreadEntryMatches(u: IUnreadFile, globs: readonly string[]): boolean {
  if (!isUnreadDirectory(u)) return globListSelects(u.path, globs);
  const { include, exclude } = globListParts(globs);
  return include.some((g) => globMayMatchUnder(g, u.path)) && !exclude.some((n) => globCoversAllUnder(n, u.path));
}

/**
 * The exemption side of {@link unreadEntryMatches}: do `globs` take the WHOLE
 * entry out of scope? A file: the list selects it. A directory: one inclusion
 * glob covers everything beneath it (`globCoversAllUnder`) and no negation
 * could carve part of it back out (`globMayMatchUnder`) — an exemption
 * covering part of an unlistable directory leaves the rest a gap.
 */
export function unreadEntryWhollyMatches(u: IUnreadFile, globs: readonly string[]): boolean {
  if (!isUnreadDirectory(u)) return globListSelects(u.path, globs);
  const { include, exclude } = globListParts(globs);
  return include.some((g) => globCoversAllUnder(g, u.path)) && !exclude.some((n) => globMayMatchUnder(n, u.path));
}

/**
 * The unread entries a selector's globs are in front of, optionally only those
 * in a changeset. Sorted by path.
 *
 * Under a changeset, an unlistable directory contributes the CHANGED files
 * beneath it that the globs match (each unreadable: its directory could not be
 * listed) — the changeset is the scope, so the gap is named by file.
 */
export function unreadMatching(
  unread: readonly IUnreadFile[],
  globs: readonly string[],
  changed?: ReadonlySet<string>,
): IUnreadFile[] {
  if (changed === undefined) return unread.filter((u) => unreadEntryMatches(u, globs));
  const out = new Map<string, IUnreadFile>();
  for (const u of unread) {
    if (!isUnreadDirectory(u)) {
      if (changed.has(u.path) && globListSelects(u.path, globs)) out.set(u.path, u);
      continue;
    }
    for (const path of changed) {
      if (!out.has(path) && unreadDirectoryContains(u, path) && globListSelects(path, globs)) {
        out.set(path, { path, reason: UnreadFileReason.Unreadable });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * One rule's read scope over a read the caller already did: the read files
 * its globs match, and the unread ones. `changed` narrows both to a changeset,
 * which is deliberate narrowing and not a gap.
 */
export function readScopeOf(
  matched: IMatchedFiles,
  globs: readonly string[],
  changed?: ReadonlySet<string>,
): IReadScope {
  let read = 0;
  for (const path of matched.files.keys()) {
    if ((changed === undefined || changed.has(path)) && globListSelects(path, globs)) read += 1;
  }
  return { read, unread: unreadMatching(matched.unread, globs, changed) };
}

/** Merge several read scopes (a rule's sides), counting each unread path once. */
export function mergeReadScopes(read: number, scopes: readonly (readonly IUnreadFile[])[]): IReadScope {
  const seen = new Map<string, IUnreadFile>();
  for (const list of scopes) for (const u of list) if (!seen.has(u.path)) seen.set(u.path, u);
  return { read, unread: [...seen.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * The read scope of SEVERAL lists over one read (a registration idiom's three
 * roles, every idiom of a graph): a file counts once when ANY list selects it,
 * and each list's unread entries are taken from that list alone.
 *
 * Never flatten the lists into one and call {@link readScopeOf}: a negation
 * subtracts from its own list only, and a flattened union would let one role's
 * `!x` hide another role's file.
 */
export function readScopeOfLists(
  matched: IMatchedFiles,
  lists: readonly (readonly string[])[],
  changed?: ReadonlySet<string>,
): IReadScope {
  let read = 0;
  for (const path of matched.files.keys()) {
    if (changed !== undefined && !changed.has(path)) continue;
    if (lists.some((l) => globListSelects(path, l))) read += 1;
  }
  return mergeReadScopes(read, lists.map((l) => unreadMatching(matched.unread, l, changed)));
}

/**
 * True when a rule's scope holds a file the reader did not read. Such a rule's
 * zero is never "matched nothing": it matched a file it could not examine. So
 * it is PARTIAL (2), never a `failOnEmpty` failure (1), and never a pass.
 */
export function readScopeHasUnread(scope: IReadScope | undefined): boolean {
  return scope !== undefined && scope.unread.length > 0;
}

/**
 * THE rule for folding the one reader's unread files into a rule's coverage.
 *
 * With no unread file in scope, the plane's own record is returned unchanged.
 * Otherwise the rule examined `read` of the `read + unread` files its globs
 * MATCHED: unit `files`, and each unread path named with its reason
 * (`examined 1 of 2 files, 1 over the 1MB read cap: src/big.ts`).
 *
 * The file record REPLACES the plane's record rather than sitting next to it.
 * Every count the plane derived (tokens, content units, entries, references)
 * came from an incomplete read, so it misses whatever the unread file holds.
 * CLAUDE.md's loud-skip rule applies: a number derived from an incomplete input
 * is reported NOT VERIFIED, never as a number. Any acceptance on the plane
 * record (`registeredExtras`, `expectEmpty`, `--allow-empty`) is dropped with
 * it, because none of them accepted an unread file.
 */
export function readScopeCoverage(plane: IVerdictCoverage, scope: IReadScope | undefined): IVerdictCoverage {
  if (scope === undefined || scope.unread.length === 0) return plane;
  const unread = scope.unread;
  return {
    unit: 'files',
    expected: scope.read + unread.length,
    examined: scope.read,
    unexamined: unread.slice(0, UNREAD_LABEL_CAP).map((u) => u.path),
    unexaminedTotal: unread.length,
    reason: unreadReason(unread),
    ...(plane.root !== undefined ? { root: plane.root } : {}),
    ...(plane.subject !== undefined ? { subject: plane.subject } : {}),
  };
}

/**
 * A short human clause for a rule's unread files, for skip reasons and hints:
 * `1 matched file over the 1MB read cap (src/big.ts)`.
 */
export function describeUnread(unread: readonly IUnreadFile[], shown = 3): string {
  const names = unread.slice(0, shown).map((u) => u.path);
  const more = unread.length > shown ? `, +${unread.length - shown} more` : '';
  return `${unread.length} matched file(s) ${unreadReason(unread)} (${names.join(', ')}${more})`;
}
