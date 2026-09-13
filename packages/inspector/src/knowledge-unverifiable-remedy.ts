/**
 * THE remedy wording for an unverifiable knowledge entry (round 15, 15.2) —
 * the stale-check's lead and per-file lines, its `--require-references`
 * findings and the `quality` item's notes all read it, so the fix a reader is
 * told cannot differ by surface.
 *
 * Markdown entries have a reference channel now (a `references:` frontmatter
 * list), so the remedy names it next to TypeScript's `references[]`. The exit
 * is unchanged — an entry nobody checked stays a shortfall (exit 2) unless an
 * explicit, printed valve accepts it.
 */
import { KnowledgeSourceFormat } from '@shrkcrft/knowledge';
import { KnowledgeEntryVerdict } from './knowledge-entry-verdict.ts';
import { KnowledgeUnverifiableReason } from './knowledge-unverifiable-reason.ts';
import type { IKnowledgeEntryVerdictRecord } from './knowledge-entry-verdict-record.ts';
import { KnowledgeMinReferencedValve } from './knowledge-min-referenced-valve.ts';
import type { IUnverifiableRemedyGroup } from './i-unverifiable-remedy-group.ts';

/** The channel sentence: both formats can declare references. */
export const DECLARE_REFERENCES_REMEDY =
  'Declare references[] (TypeScript) or a references: frontmatter list (Markdown)';

/** Per-file remedies printed before the rest are summarised. */
const FILE_REMEDIES_SHOWN = 5;

/** The valve a surface names (the verb takes the flag; `quality` refuses it). */
export function minReferencedValveText(valve: KnowledgeMinReferencedValve): string {
  return valve === KnowledgeMinReferencedValve.Flag
    ? '--min-referenced <ratio> (or knowledgeCheck.minReferenced in sharkcraft.config.ts)'
    : 'knowledgeCheck.minReferenced in sharkcraft.config.ts (quality takes no --min-referenced flag)';
}

/** What an entry that declares references, none checkable, is told to do — about ITS declaration. */
const FIX_DECLARED = 'fix the item its INVALID / UNKNOWN row names, or add a checkable one';

/** The same, said of a run's entries. */
const FIX_DECLARED_RUN = 'fix the item each INVALID / UNKNOWN row names';

/** The declare-channel clause of the unverifiable list's heading. */
const DECLARE_CHANNELS = 'declare references[] (TypeScript), a references: frontmatter list (Markdown) or anchors[]';

/**
 * The fix for ONE unverifiable entry — `undefined` only for a local TypeScript
 * (or other non-Markdown) entry that declares NOTHING (the heading names
 * `references[]`). It branches on the verdict REASON (round 15 closing, A4): an
 * entry that declares references, none checkable (a malformed item — a
 * non-boolean `required`, an unknown kind or `root` — or only `url:`s), is told
 * to fix what it declared, never to "add a references: frontmatter list" /
 * "declare references[]" it already has. A pack's entries are fixed upstream;
 * their `file:` / `directory:` paths resolve against the CONSUMER's root unless
 * the reference declares `root: pack` (round 15 follow-up, F7 — then against
 * the pack's own directory), and `package:` reads the consumer's root
 * package.json plus the pack's own name.
 */
export function unverifiableFileRemedy(
  v: Pick<IKnowledgeEntryVerdictRecord, 'sourceFormat' | 'pack' | 'reason'>,
): string | undefined {
  const markdown = v.sourceFormat === KnowledgeSourceFormat.Markdown;
  // An entry that DECLARES references, none checkable: "add a references:
  // list" told its author to write what is already there (round 15 follow-up
  // review, F10 — and a TypeScript one read "declare references[]", A4).
  const declaresSome = v.reason === KnowledgeUnverifiableReason.OnlyUnverifiableReferences;
  if (v.pack !== undefined) {
    const how = declaresSome
      ? 'make one of its references checkable'
      : markdown
        ? 'add a references: frontmatter list'
        : 'declare references[]';
    return (
      `pack ${v.pack}${markdown ? ' (Markdown)' : ''}: ${how} upstream — id kinds (template:, playbook:, command:, …) ` +
      "resolve in every consumer; file: and directory: paths resolve against the consumer's root — declare root: pack " +
      "on a reference to a file the pack ships"
    );
  }
  if (declaresSome) {
    return markdown
      ? `Markdown: its references: frontmatter list declares nothing checkable — ${FIX_DECLARED} (e.g. file:src/a.ts)`
      : `its references[] / anchors[] declare nothing checkable — ${FIX_DECLARED}`;
  }
  if (!markdown) return undefined;
  return 'Markdown: add a references: frontmatter list (e.g. references: [file:src/a.ts])';
}

/**
 * {@link unverifiableFileRemedy} for EVERY entry — what a per-entry row (the
 * `--require-references` violation) prints: a local TypeScript entry that
 * declares nothing is told to declare `references[]`, one whose references are
 * all uncheckable to fix them (it read "declare references[]").
 */
export function unverifiableEntryRemedy(
  v: Pick<IKnowledgeEntryVerdictRecord, 'sourceFormat' | 'pack' | 'reason'>,
): string {
  return unverifiableFileRemedy(v) ?? 'declare references[]';
}

/** Which reasons the run's unverifiable entries carry: declare nothing / declare only uncheckable references. */
function reasonMix(verdicts: readonly Pick<IKnowledgeEntryVerdictRecord, 'verdict' | 'reason'>[]): {
  readonly none: boolean;
  readonly some: boolean;
} {
  let none = false;
  let some = false;
  for (const v of verdicts) {
    if (v.verdict !== KnowledgeEntryVerdict.Unverifiable) continue;
    if (v.reason === KnowledgeUnverifiableReason.OnlyUnverifiableReferences) some = true;
    else none = true;
  }
  return { none, some };
}

/**
 * The heading of the unverifiable list, after `UNVERIFIABLE (N) — never
 * checked; ` — by reason (round 15 closing, A4): it told every entry to
 * "declare references[] …, a references: frontmatter list (Markdown) or
 * anchors[]", over entries whose references exist and are malformed.
 */
export function unverifiableListHeading(verdicts: readonly Pick<IKnowledgeEntryVerdictRecord, 'verdict' | 'reason'>[]): string {
  const { none, some } = reasonMix(verdicts);
  if (!some) return DECLARE_CHANNELS;
  if (!none) return `each declares references, none checkable — ${FIX_DECLARED_RUN}`;
  return `${DECLARE_CHANNELS} where none is declared; where some are, ${FIX_DECLARED_RUN}`;
}

/**
 * The remedy sentence for a run with unverifiable entries: the channel (or,
 * for entries that declare references none of which is checkable, the fix to
 * them — round 15 closing, A4), the valve this surface can name, and — when a
 * pack contributed any of them — the pack that fixes them upstream.
 */
export function unverifiableRemedy(
  verdicts: readonly Pick<IKnowledgeEntryVerdictRecord, 'verdict' | 'pack' | 'reason'>[],
  valve: KnowledgeMinReferencedValve,
): string {
  const packs = [
    ...new Set(
      verdicts
        .filter((v) => v.verdict === KnowledgeEntryVerdict.Unverifiable && v.pack !== undefined)
        .map((v) => v.pack!),
    ),
  ];
  const upstream =
    packs.length > 0
      ? ` Entries a pack contributes (${packs.map((p) => `pack ${p}`).join(', ')}) are fixed in the pack.`
      : '';
  const { none, some } = reasonMix(verdicts);
  const how = !some
    ? DECLARE_REFERENCES_REMEDY
    : !none
      ? `Make a declared reference checkable — ${FIX_DECLARED_RUN}`
      : `${DECLARE_REFERENCES_REMEDY} where none is declared, or ${FIX_DECLARED_RUN} where one is`;
  return `${how} (ids listed above), or accept a floor explicitly with ${minReferencedValveText(valve)}.${upstream}`;
}

/**
 * Unverifiable entries grouped by declaring file AND remedy, in report order —
 * THE grouping the stale-check's per-file lines and `quality`'s notes read. A
 * file whose entries need different fixes gets one group per fix: the first
 * entry's remedy used to speak for its whole file (round 15 closing, A4).
 */
export function unverifiableRemedyGroups(
  verdicts: readonly Pick<IKnowledgeEntryVerdictRecord, 'entryId' | 'verdict' | 'source' | 'sourceFormat' | 'pack' | 'reason'>[],
): IUnverifiableRemedyGroup[] {
  const groups = new Map<string, { source: string; ids: string[]; remedy?: string }>();
  for (const v of verdicts) {
    if (v.verdict !== KnowledgeEntryVerdict.Unverifiable) continue;
    const remedy = unverifiableFileRemedy(v);
    const key = `${v.source} ${remedy ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { source: v.source, ids: [], ...(remedy !== undefined ? { remedy } : {}) };
      groups.set(key, group);
    }
    group.ids.push(v.entryId);
  }
  return [...groups.values()];
}

/**
 * `<file>: <remedy>` for each file whose unverifiable entries need more than
 * `references[]`, capped — `<file> (<ids>): <remedy>` when that file's entries
 * need different fixes ({@link unverifiableRemedyGroups}).
 */
export function unverifiableFileRemedies(
  verdicts: readonly Pick<IKnowledgeEntryVerdictRecord, 'entryId' | 'verdict' | 'source' | 'sourceFormat' | 'pack' | 'reason'>[],
): string[] {
  const groups = unverifiableRemedyGroups(verdicts);
  const perSource = new Map<string, number>();
  for (const g of groups) perSource.set(g.source, (perSource.get(g.source) ?? 0) + 1);
  const lines = groups
    .filter((g) => g.remedy !== undefined)
    .map((g) => `${(perSource.get(g.source) ?? 0) > 1 ? `${g.source} (${g.ids.join(', ')})` : g.source}: ${g.remedy}`);
  return lines.length > FILE_REMEDIES_SHOWN
    ? [...lines.slice(0, FILE_REMEDIES_SHOWN), `… ${lines.length - FILE_REMEDIES_SHOWN} more file(s)`]
    : lines;
}
