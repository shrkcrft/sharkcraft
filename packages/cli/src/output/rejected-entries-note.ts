/**
 * THE list-verb note (round 12, 12.1 — and, since the round-12 review (A-4),
 * the files that failed to load).
 *
 * A contributed entry its loader refused used to vanish: the `list` verb
 * printed the survivors and exited 0, and nothing said an entry was dropped.
 * A contribution FILE that failed to import dropped every entry it declares
 * just as silently — `conventions list` even pointed at that very file as the
 * place to contribute. Every list verb now prints, after its list, one line
 * per file:
 *
 *   ⚠ sharkcraft/conventions.ts failed to load (boom) — nothing in it is listed → shrk conventions doctor
 *   ⚠ 2 entries rejected from node_modules/@r12/pack/conventions.ts: 'conv.b' (default[8]) — severity: …; 'conv.j' (default[9]) — … → shrk conventions doctor
 *
 * with the wording of THE formatter (`formatEntryRejection`), from THE channel
 * (`collectKindOutcomes`). A list verb is not a verdict: its exit stays 0.
 * Under `--json` the stdout array is untouched (a parser never breaks) and the
 * note goes to stderr, one line per failed file plus one for the rejections.
 */
import {
  collectKindOutcomes,
  contributionFileLabel,
  formatEntryRejection,
  type ContributionKind,
  type IContributionEntryRejection,
  type IContributionLoadFailure,
  type IKindOutcomes,
  type inspectSharkcraft,
} from '@shrkcrft/inspector';

type IInspection = Awaited<ReturnType<typeof inspectSharkcraft>>;

/** Narrow to what a `--source local|pack` list shows: a pack record has an owning pack. */
function bySource<T extends { readonly packageName?: string }>(records: readonly T[], source?: string): readonly T[] {
  if (source === 'pack') return records.filter((r) => r.packageName !== undefined);
  if (source === 'local') return records.filter((r) => r.packageName === undefined);
  if (source === 'builtin') return [];
  return records;
}

/** The note lines (text, stdout) — `''` when nothing was rejected. */
export function rejectedEntriesNote(
  rejections: readonly IContributionEntryRejection[],
  projectRoot: string,
  next?: string,
): string {
  if (rejections.length === 0) return '';
  const byFile = new Map<string, IContributionEntryRejection[]>();
  for (const r of rejections) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r]);
  const lines: string[] = [];
  for (const [file, list] of byFile) {
    lines.push(
      `⚠ ${list.length} ${list.length === 1 ? 'entry' : 'entries'} rejected from ${contributionFileLabel(projectRoot, file)}: ${list
        .map((r) => formatEntryRejection(r))
        .join('; ')}${next ? ` → ${next}` : ''}`,
    );
  }
  return lines.join('\n') + '\n';
}

/** The one-line `--json` stderr form — `''` when nothing was rejected. */
export function rejectedEntriesStderrNote(
  rejections: readonly IContributionEntryRejection[],
  projectRoot: string,
  next?: string,
): string {
  if (rejections.length === 0) return '';
  const files = [...new Set(rejections.map((r) => contributionFileLabel(projectRoot, r.file)))];
  return `note: ${rejections.length} ${rejections.length === 1 ? 'entry' : 'entries'} rejected by the loader from ${files.join(', ')} — not listed above${next ? ` (see ${next})` : ''}\n`;
}

/** One line per contribution file that failed to load (text, stdout) — `''` when every file loaded. */
export function loadFailuresNote(
  failures: readonly IContributionLoadFailure[],
  projectRoot: string,
  next?: string,
): string {
  if (failures.length === 0) return '';
  return (
    failures
      .map(
        (f) =>
          `⚠ ${contributionFileLabel(projectRoot, f.file)} failed to load (${f.message}) — nothing in it is listed${next ? ` → ${next}` : ''}`,
      )
      .join('\n') + '\n'
  );
}

/** The `--json` stderr form, one line per failed file — `''` when every file loaded. */
export function loadFailuresStderrNote(
  failures: readonly IContributionLoadFailure[],
  projectRoot: string,
  next?: string,
): string {
  if (failures.length === 0) return '';
  return (
    failures
      .map(
        (f) =>
          `note: ${contributionFileLabel(projectRoot, f.file)} failed to load (${f.message}) — nothing in it is listed above${next ? ` (see ${next})` : ''}`,
      )
      .join('\n') + '\n'
  );
}

/**
 * What `kinds`' loaders reported — refused entries and files that never
 * loaded — narrowed to `--source`. `loadFailures: false` for a verb that
 * already reports its own load failures (knowledge list's partial-list WARN,
 * helper list's broken-file line), so no failure is said twice.
 */
export async function collectListVerbNote(
  inspection: IInspection,
  kinds: readonly ContributionKind[],
  options: { readonly source?: string; readonly loadFailures?: boolean } = {},
): Promise<IKindOutcomes> {
  const outcomes = await collectKindOutcomes(inspection, kinds);
  return {
    rejections: bySource(outcomes.rejections, options.source),
    loadFailures: options.loadFailures === false ? [] : bySource(outcomes.loadFailures, options.source),
  };
}

/** Write a collected note: text after the list on stdout, or stderr lines under `--json`. */
export function writeListVerbNote(
  outcomes: IKindOutcomes,
  projectRoot: string,
  options: { readonly json?: boolean; readonly next?: string } = {},
): void {
  const { rejections, loadFailures } = outcomes;
  if (rejections.length === 0 && loadFailures.length === 0) return;
  if (options.json) {
    process.stderr.write(
      loadFailuresStderrNote(loadFailures, projectRoot, options.next) +
        rejectedEntriesStderrNote(rejections, projectRoot, options.next),
    );
    return;
  }
  process.stdout.write(
    `\n${loadFailuresNote(loadFailures, projectRoot, options.next)}${rejectedEntriesNote(rejections, projectRoot, options.next)}`,
  );
}

/**
 * Collect `kinds`' outcomes (THE channel, running only the loaders those
 * kinds need) and write the note: text after the list on stdout, or stderr
 * lines under `--json`. Returns the rejections it reported.
 */
export async function writeRejectedEntriesNote(
  inspection: IInspection,
  kinds: readonly ContributionKind[],
  options: {
    readonly json?: boolean;
    readonly source?: string;
    readonly next?: string;
    readonly loadFailures?: boolean;
  } = {},
): Promise<readonly IContributionEntryRejection[]> {
  const outcomes = await collectListVerbNote(inspection, kinds, options);
  writeListVerbNote(outcomes, inspection.projectRoot, options);
  return outcomes.rejections;
}
