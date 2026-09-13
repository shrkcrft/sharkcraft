/**
 * `shrk conventions ...` — pack/local conventions surface.
 *
 * Read-only listing + doctor + check. `check` runs the loaded conventions
 * against caller-supplied files (or git diff). Never writes.
 */
import { RejectionCause, type IVerdictCoverage } from '@shrkcrft/core';
import {
  checkConventionsAgainstFiles,
  collectKindOutcomes,
  ContributionKind,
  contributionFileLabel,
  conventionApplicability,
  findConvention,
  formatEntryRejection,
  getChangedFiles,
  inspectSharkcraft,
  listConventions,
  loadConventions,
  type IContributionEntryRejection,
  type IConventionApplicability,
  type IConventionApplicabilityReason,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { ExitCode } from '../exit-codes.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { buildGateEnvelope, type IGateRuleResult } from '../gates/gate-envelope.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { asJson, header } from '../output/format-output.ts';
import { collectListVerbNote, writeListVerbNote } from '../output/rejected-entries-note.ts';

/**
 * The `acceptedBy` a not-applicable convention's coverage carries in `conventions
 * check` (round 15, 15.1): its `appliesTo` proved it does not apply, so it was
 * never evaluated — an explicit, printed acceptance, never a silent skip.
 */
const APPLIES_TO_ACCEPTED_BY = 'appliesTo';

/** The reasons, one sentence each, `; `-joined. */
function reasonsText(reasons: readonly IConventionApplicabilityReason[]): string {
  return reasons.map((r) => r.message).join('; ');
}

/**
 * THE applicability display of `list` / `get` / `explain` (round 15): what
 * `conventionApplicability` decided, never a hidden entry. `undefined` when the
 * convention declares no filter (it applies everywhere).
 */
function applicabilityLine(a: IConventionApplicability): string | undefined {
  if (a.reasons.length === 0) return undefined;
  if (a.applicable) return `applies — ${reasonsText(a.reasons)}`;
  return `not applicable here — ${reasonsText(a.reasons.filter((r) => !r.matched))}`;
}

/**
 * `conventions check`'s reading of a convention the loader REJECTED (round 15
 * follow-up, F2 — the seam-rejected gate-rule precedent, R12-X1,
 * `gates/seam-rejected-rules.ts`): a declared convention that did NOT run — an
 * ERRORED row, `rejected at load — NOT evaluated`, so the verb exits 1 over it.
 * A `duplicate-id` rejection is NOT a row: the declaration it collided with is
 * a convention that runs (it is printed as a note and carried in `rejected[]`).
 *
 * One row per refused DECLARATION — identified by where it was declared (file,
 * export, index), never by its id (L1 review): two invalid declarations of
 * `c.bad` (a local one and a pack's) are two conventions that did not run, and
 * keying on the id dropped the second from the rows and the `N rejected` count
 * while `rejected[]` listed both. A row id is unique among `gate.rules`: an id a
 * loaded convention (or an earlier refused declaration) already holds is
 * qualified by its declaration site — `c.x (node_modules/@p/x/conventions.ts[0])`
 * — so a shortfall never reads as if the convention that RAN was not evaluated.
 */
function rejectedConventionRows(
  rejections: readonly IContributionEntryRejection[],
  projectRoot: string,
  loadedIds: ReadonlySet<string>,
): IGateRuleResult[] {
  const rows: IGateRuleResult[] = [];
  const seen = new Set<string>();
  const taken = new Set<string>(loadedIds);
  for (const r of rejections) {
    if (r.cause === RejectionCause.DuplicateId) continue;
    const file = contributionFileLabel(projectRoot, r.file);
    const declaration = `${file}|${r.exportName ?? ''}|${r.index}`;
    if (seen.has(declaration)) continue;
    seen.add(declaration);
    const site = r.index >= 0 ? `${file}[${r.index}]` : file;
    let id = r.entryId !== undefined && !taken.has(r.entryId) ? r.entryId : r.entryId !== undefined ? `${r.entryId} (${site})` : site;
    for (let n = 2; taken.has(id); n += 1) id = `${r.entryId ?? site} (${site}${r.exportName ? ` ${r.exportName}` : ''} #${n})`;
    taken.add(id);
    const pack = r.packageName ? `pack ${r.packageName} ` : '';
    rows.push({
      id,
      type: 'convention',
      status: 'error',
      severity: 'error',
      counts: {},
      violations: [],
      error: `${pack}convention rejected at load — NOT evaluated: ${formatEntryRejection(r)} (${file})`,
      coverage: { unit: 'conventions', expected: 1, examined: 0, subject: id, reason: 'rejected at load — NOT evaluated' },
    });
  }
  return rows;
}

/** One `--json` `rejected[]` record: where the refused convention was declared, why, and by which pack. */
function rejectedRecord(r: IContributionEntryRejection, projectRoot: string): Record<string, unknown> {
  return {
    ...(r.entryId !== undefined ? { entryId: r.entryId } : {}),
    file: contributionFileLabel(projectRoot, r.file),
    index: r.index,
    ...(r.exportName ? { exportName: r.exportName } : {}),
    ...(r.packageName ? { packageName: r.packageName } : {}),
    cause: r.cause,
    reasons: r.reasons,
  };
}

export const conventionsListCommand: ICommandHandler = {
  name: 'list',
  description:
    'List registered conventions, each with its applicability here (appliesTo judged against the detected workspace — a not-applicable convention is listed, never hidden). Read-only.',
  usage: 'shrk conventions list [--kind <kind>] [--source local|pack] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entries = await listConventions(inspection);
    const kind = flagString(args, 'kind');
    const source = flagString(args, 'source');
    let filtered = entries;
    if (kind) filtered = filtered.filter((e) => e.convention.kind === kind);
    if (source) filtered = filtered.filter((e) => e.source === source);
    // A convention its loader refused, and a conventions file that failed to
    // load, are said out loud (round 12, 12.1 + review A-4) — never a silently
    // shorter list. The exit stays 0: a list is no verdict.
    const note = { source, next: 'shrk conventions doctor' };
    const outcomes = await collectListVerbNote(inspection, [ContributionKind.Convention], note);
    if (flagBool(args, 'json')) {
      // Additive (round 15): each entry carries its `applicability`.
      process.stdout.write(
        asJson(filtered.map((e) => ({ ...e, applicability: conventionApplicability(e.convention, inspection) }))) + '\n',
      );
      writeListVerbNote(outcomes, inspection.projectRoot, { ...note, json: true });
      return 0;
    }
    process.stdout.write(header(`Conventions (${filtered.length})`));
    if (filtered.length === 0) {
      // Never point at a conventions file that exists and FAILED as the place
      // to contribute — the note below names it and its error.
      process.stdout.write(
        outcomes.loadFailures.length > 0
          ? '  (none loaded — a conventions file failed to load; see below)\n'
          : '  (none — contribute via a pack manifest "conventionFiles" entry or sharkcraft/conventions.ts)\n',
      );
    }
    for (const e of filtered) {
      const src = e.source === 'pack' ? `pack:${e.packageName ?? '?'}` : e.source;
      process.stdout.write(
        `  • ${e.convention.kind.padEnd(12)} ${e.convention.id.padEnd(28)} ${e.convention.title}  [${src}]\n`,
      );
      const line = applicabilityLine(conventionApplicability(e.convention, inspection));
      if (line) process.stdout.write(`      ${line}\n`);
    }
    writeListVerbNote(outcomes, inspection.projectRoot, note);
    return 0;
  },
};

export const conventionsGetCommand: ICommandHandler = {
  name: 'get',
  description:
    'Show a single convention by id — description, appliesTo and its applicability here, rules, examples, references and tags.',
  usage: 'shrk conventions get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk conventions get <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const entry = await findConvention(inspection, id);
    if (!entry) {
      process.stderr.write(`Unknown convention "${id}".\n`);
      return 2;
    }
    const applicability = conventionApplicability(entry.convention, inspection);
    if (flagBool(args, 'json')) {
      // Additive (round 15): `applicability` beside the entry's own fields.
      process.stdout.write(asJson({ ...entry, applicability }) + '\n');
      return 0;
    }
    const c = entry.convention;
    process.stdout.write(header(`Convention ${c.id} (${c.kind})`));
    process.stdout.write(`  title         ${c.title}\n`);
    if (c.description) process.stdout.write(`  description   ${c.description}\n`);
    process.stdout.write(`  severity      ${c.severity}\n`);
    process.stdout.write(`  source        ${entry.source}${entry.packageName ? ' (' + entry.packageName + ')' : ''}\n`);
    process.stdout.write(`  sourceFile    ${entry.sourceFile}\n`);
    // Round 15: `explain` claimed to show references and neither verb printed
    // appliesTo, references or tags — the filters that decide where the
    // convention applies were invisible in text.
    const declared = Object.entries(c.appliesTo ?? {}).filter(([, v]) => Array.isArray(v) && v.length > 0);
    process.stdout.write(
      `  appliesTo     ${
        declared.length > 0
          ? declared.map(([k, v]) => `${k} [${(v as readonly string[]).join(', ')}]`).join(' · ')
          : '(no filter — applies to every file)'
      }\n`,
    );
    process.stdout.write(`  applicability ${applicability.applicable ? 'applies here' : 'NOT applicable here'}\n`);
    for (const r of applicability.reasons) {
      process.stdout.write(`    ${r.matched ? '✓' : '✗'} ${r.message}\n`);
    }
    process.stdout.write(`  rules (${c.rules.length}):\n`);
    for (const r of c.rules) {
      process.stdout.write(`    • ${r.id}  ${r.description}\n`);
      for (const key of ['filePattern', 'expectMatch', 'forbidMatch'] as const) {
        if (typeof r[key] === 'string') process.stdout.write(`        ${key.padEnd(11)} /${r[key]}/\n`);
      }
    }
    if (c.examples && c.examples.length > 0) {
      process.stdout.write(`  examples (${c.examples.length}):\n`);
      for (const e of c.examples) process.stdout.write(`    • ${e.description}\n`);
    }
    const references = Array.isArray(c.references) ? c.references : [];
    if (references.length > 0) {
      process.stdout.write(`  references (${references.length}):\n`);
      for (const r of references) process.stdout.write(`    • ${r.kind}: ${r.value}\n`);
    }
    const tags = Array.isArray(c.tags) ? c.tags : [];
    if (tags.length > 0) process.stdout.write(`  tags          ${tags.join(', ')}\n`);
    return 0;
  },
};

export const conventionsDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Surface load / validation issues for conventions — an invalid shape (a kind, severity or reference kind outside its closed set is named with the allowed values), a shape warning, a file that failed to load. Exit 0 · 1 an invalid convention (or a warning under --strict) · 2 a convention file never read, or none discovered (--allow-empty accepts that explicitly). Read-only.',
  usage: 'shrk conventions doctor [--strict] [--allow-empty] [--json]',
  booleanFlags: new Set(['json', 'strict', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const { entries, issues, files } = await loadConventions(inspection);
    // Convention FILES are the unit: a file that failed to load was never
    // validated, so "no issues" over it is not a pass.
    const coverage: IVerdictCoverage = {
      unit: 'convention files',
      expected: files.discovered,
      examined: files.discovered - files.unread.length,
      root: inspection.projectRoot,
      reason:
        files.discovered === 0
          ? 'no sharkcraft/conventions.ts, conventionFiles entry or pack conventionFiles'
          : 'missing or failed to load, so their conventions were never validated',
      ...(files.unread.length > 0 ? { unexamined: files.unread.slice(0, 20), unexaminedTotal: files.unread.length } : {}),
      ...allowEmptyValve(args, files.discovered),
    };
    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    const strict = flagBool(args, 'strict');
    const settled = settleVerdict(errors > 0 || (strict && warnings > 0) ? 1 : 0, [coverage]);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          issues,
          conventions: entries.length,
          files,
          coverage,
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
          accepted: settled.accepted,
        }) + '\n',
      );
      return settled.exit;
    }
    process.stdout.write(header('Conventions doctor'));
    process.stdout.write(
      `  ${entries.length} convention(s) loaded from ${files.discovered - files.unread.length} of ${files.discovered} file(s) · ${errors} error(s) · ${warnings} warning(s)\n`,
    );
    for (const i of issues) {
      const where = i.conventionId ? ` ${i.conventionId}` : '';
      process.stdout.write(`  ${i.severity.padEnd(7)} [${i.code}]${where} ${i.message}\n`);
    }
    const clean =
      files.discovered === 0
        ? 'No conventions declared — accepted.'
        : warnings > 0
          ? `No blocking convention issues — ${warnings} warning(s) reported above.`
          : 'ok — no load/validation issues.';
    const line = verdictLine(
      settled,
      clean,
      files.discovered === 0 ? 'No convention files discovered — nothing validated.' : undefined,
    );
    if (line) process.stdout.write(`\n${line}\n`);
    if (settled.exit === ExitCode.NotVerified && files.discovered === 0) {
      process.stdout.write('Pass --allow-empty to accept a project with no conventions explicitly.\n');
    }
    return settled.exit;
  },
};

export const conventionsCheckCommand: ICommandHandler = {
  name: 'check',
  description:
    'Run the loaded conventions against files (--files / --since / --staged, each path realpath-normalized; default: the working-tree change). Every appliesTo filter scopes: a convention whose filters exclude this workspace or every file in scope is NOT APPLICABLE — never evaluated, always printed with its reason (--json notApplicable[]) and accepted explicitly. A convention the loader rejected is an ERRORED row with its reasons (--json rejected[]). Exit 0 no error-severity hit · 1 an error-severity hit, or a rejected convention · 2 NOT VERIFIED — no file in scope, no convention declared, no convention applicable (--allow-empty accepts these explicitly), or a convention file never read · 3 usage. Read-only.',
  usage: 'shrk conventions check [--files a,b,c] [--since <ref>] [--staged] [--allow-empty] [--json]',
  booleanFlags: new Set(['json', 'staged', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    let files: readonly string[] = [];
    let scope = 'the working-tree change';
    const explicit = flagList(args, 'files');
    if (explicit.length > 0) {
      files = explicit;
      scope = '--files';
    } else if (flagBool(args, 'staged')) {
      // Project-root-relative paths (round 15 lane B, B4): the git scope is
      // read from the project root, so a project nested in a larger repository,
      // or a --cwd below the root, names the files the checker resolves.
      files = getChangedFiles(inspection.projectRoot, { staged: true });
      scope = 'the staged change';
    } else {
      const since = flagString(args, 'since');
      files = since ? getChangedFiles(inspection.projectRoot, { since }) : getChangedFiles(inspection.projectRoot, {});
      if (since) scope = `the change since ${since}`;
    }
    // Round 13: a verdict verb. "Nothing to check" is not a pass — an empty
    // file scope, a project with no convention, or a convention file that
    // never loaded (its conventions were never checked) settle NOT VERIFIED
    // (2) through the shared gate envelope; it printed "ok — no violations"
    // at exit 0 over all three. `--allow-empty` accepts an empty scope or an
    // empty registry explicitly (printed) — never an unread file.
    const loaded = await loadConventions(inspection);
    const report = await checkConventionsAgainstFiles(inspection, files);
    const unread = loaded.files.unread;
    // Round 15 follow-up (F2): a convention the loader REJECTED is a declared
    // convention that never ran — an ERRORED row (exit 1), read through THE
    // rejection channel `conventions list` reads. It used to vanish: check
    // printed "ok — no violations." at 0 over it. A duplicate id is a note, not
    // a row: the declaration it collided with runs.
    const { rejections } = await collectKindOutcomes(inspection, [ContributionKind.Convention]);
    const rejectedRows = rejectedConventionRows(
      rejections,
      inspection.projectRoot,
      new Set(loaded.entries.map((e) => e.convention.id)),
    );
    const duplicates = rejections.filter((r) => r.cause === RejectionCause.DuplicateId);
    // Round 15 (15.1): a convention whose `appliesTo` excludes this workspace
    // (or every file in scope) is NOT APPLICABLE — never evaluated. Its row is
    // `skipped` with an explicit acceptance (`acceptedBy: 'appliesTo'`), so a
    // clean exit over it is honest and `evaluated` never counts it; it is
    // printed below whatever the exit (an acceptance is dropped at 1).
    const notApplicable = new Map(report.notApplicable.map((n) => [n.conventionId, n]));
    const applicable = loaded.entries.length - report.notApplicable.length;
    const noneApplicable = loaded.entries.length > 0 && applicable === 0;
    // "Nothing applied" is not a pass either: when conventions loaded and NONE
    // applies, nothing checked the files — 2, unless --allow-empty accepts it
    // (expected = the applicable count keeps the valve reachable). A RUN-level
    // record (round 15 follow-up, F1): it was a pseudo-row, counted in
    // `gate.evaluated` as if it were a convention that ran.
    const runRecords: IVerdictCoverage[] =
      loaded.entries.length > 0
        ? [
            {
              unit: 'applicable conventions',
              expected: applicable,
              examined: applicable,
              root: inspection.projectRoot,
              reason:
                'every loaded convention is not applicable here (its appliesTo excludes this workspace or every file in scope) — nothing checked the files',
              ...allowEmptyValve(args, applicable),
            },
          ]
        : [];
    const rows: IGateRuleResult[] = [
      {
        id: 'convention files',
        type: 'convention',
        status: 'passed',
        severity: 'warning',
        counts: { discovered: loaded.files.discovered, unread: unread.length, conventions: loaded.entries.length },
        violations: [],
        coverage: {
          unit: 'convention files',
          expected: loaded.files.discovered,
          examined: loaded.files.discovered - unread.length,
          root: inspection.projectRoot,
          reason:
            loaded.files.discovered === 0
              ? 'no sharkcraft/conventions.ts, conventionFiles entry or pack conventionFiles — nothing to check the files against'
              : 'missing or failed to load, so their conventions were never checked',
          ...(unread.length > 0 ? { unexamined: unread.slice(0, 20), unexaminedTotal: unread.length } : {}),
          ...allowEmptyValve(args, loaded.files.discovered),
        },
      },
      ...loaded.entries.map((e): IGateRuleResult => {
        const severity = e.convention.severity === 'error' ? 'error' : 'warning';
        const na = notApplicable.get(e.convention.id);
        if (na) {
          const why = reasonsText(na.reasons);
          return {
            id: e.convention.id,
            type: 'convention',
            status: 'skipped',
            severity,
            counts: { rules: e.convention.rules.length, hits: 0, files: 0 },
            violations: [],
            skipReason: `not applicable — ${why}`,
            coverage: {
              unit: 'conventions',
              expected: 1,
              examined: 0,
              reason: `not applicable — ${why}`,
              acceptedBy: APPLIES_TO_ACCEPTED_BY,
            },
          };
        }
        const hits = report.hits.filter((h) => h.conventionId === e.convention.id);
        return {
          id: e.convention.id,
          type: 'convention',
          status: hits.some((h) => h.severity === 'error') ? 'failed' : 'passed',
          severity,
          counts: { rules: e.convention.rules.length, hits: hits.length, files: report.filesInScope[e.convention.id] ?? 0 },
          violations: hits.map((h) => ({ id: `${h.conventionId}/${h.ruleId}`, file: h.file, message: h.message })),
          coverage: { unit: 'conventions', expected: 1, examined: 1 },
        };
      }),
      ...rejectedRows,
    ];
    const gate = buildGateEnvelope(
      'conventions check',
      report.verdict === 'clean' && rejectedRows.length === 0 ? ExitCode.VerifiedPass : ExitCode.Failure,
      rows,
      {
        unit: 'files',
        expected: files.length,
        examined: files.length,
        root: inspection.projectRoot,
        reason: `no file in ${scope} — nothing to check the conventions against`,
        ...allowEmptyValve(args, files.length),
      },
      runRecords,
    );
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          ...report,
          // The engine's `clean` over an empty scope is not a pass (round 13
          // review): at 2 the top-level verdict says so, never contradicting
          // `exitCode` / `gate.verdict` beside it — nor is it at 1 over a
          // rejected convention the engine never saw (round 15 follow-up, F2).
          verdict:
            gate.exit === ExitCode.NotVerified
              ? 'not-verified'
              : gate.exit === ExitCode.VerifiedPass
                ? report.verdict
                : 'has-violations',
          conventions: loaded.entries.length,
          // Round 15: `notApplicable[]` (with each one's reasons) rides in from
          // the engine report above; this is the count that WAS evaluated.
          applicable,
          // Round 15 follow-up (F2): every declared convention the loader
          // refused, with its cause and every reason (`invalid` ones are the
          // errored `gate.rules` rows; a `duplicate-id` one is not a row).
          rejected: rejections.map((r) => rejectedRecord(r, inspection.projectRoot)),
          exitCode: gate.exit,
          shortfalls: gate.shortfalls,
          accepted: gate.accepted,
          gate,
        }) + '\n',
      );
      return gate.exit;
    }
    const naCount = report.notApplicable.length;
    const rejectedCount = rejectedRows.length;
    process.stdout.write(
      header(
        `Convention check (${report.filesScanned} files, ${report.hits.length} hits${naCount > 0 ? `, ${naCount} not applicable` : ''}${rejectedCount > 0 ? `, ${rejectedCount} rejected` : ''})`,
      ),
    );
    for (const h of report.hits.slice(0, 200)) {
      process.stdout.write(`  ${h.severity.padEnd(7)} ${h.conventionId}/${h.ruleId} — ${h.file}\n`);
      process.stdout.write(`           ${h.message}\n`);
    }
    // Every convention the loader rejected — an ERRORED row, never evaluated.
    for (const row of rejectedRows) process.stdout.write(`  ${'error'.padEnd(7)} ${row.error ?? row.id}\n`);
    for (const d of duplicates) {
      process.stdout.write(
        `  ${'note'.padEnd(7)} ${formatEntryRejection(d)} — this declaration is not evaluated; the first one runs (${contributionFileLabel(inspection.projectRoot, d.file)})\n`,
      );
    }
    // Every not-applicable convention, with its reasons — in every exit.
    for (const n of report.notApplicable) {
      process.stdout.write(`  ${'n/a'.padEnd(7)} ${n.conventionId} — not applicable: ${reasonsText(n.reasons)}\n`);
    }
    const empty = files.length === 0 || loaded.files.discovered === 0;
    const warnings = report.hits.filter((h) => h.severity !== 'error').length;
    const clean = empty
      ? 'Nothing to check — accepted.'
      : noneApplicable
        ? 'No convention applies here — accepted.'
        : warnings > 0
          ? `No blocking convention violation — ${warnings} non-error hit(s) reported above.`
          : naCount > 0
            ? `ok — no violations among the ${applicable} applicable convention(s); ${naCount} not applicable (listed above).`
            : 'ok — no violations.';
    const line = verdictLine(gate, clean);
    if (line) process.stdout.write(`\n${line}\n`);
    if (gate.exit === ExitCode.NotVerified && (empty || noneApplicable)) {
      process.stdout.write(
        noneApplicable && !empty
          ? `Pass --${ALLOW_EMPTY_FLAG} to accept, explicitly, that no convention applies here.\n`
          : `Pass --${ALLOW_EMPTY_FLAG} to accept an empty changeset or a project with no conventions explicitly.\n`,
      );
    }
    if (rejectedCount > 0) {
      process.stdout.write(
        `${rejectedCount} convention(s) rejected at load were NOT evaluated — fix them (shrk conventions doctor lists every reason).\n`,
      );
    }
    return gate.exit;
  },
};

export const conventionsExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Explain a convention (description + appliesTo and its applicability here + rules + examples + references + tags).',
  usage: 'shrk conventions explain <id>',
  async run(args: ParsedArgs): Promise<number> {
    return conventionsGetCommand.run(args);
  },
};

export const conventionsCommand: ICommandHandler = {
  name: 'conventions',
  description:
    'Generic conventions registry (naming / path / barrel / layout / command / validation / ownership / testing / release / safety). Read-only.',
  usage: 'shrk conventions list|get|doctor|check|explain ...',
  // Declared (round 11 review): the dispatcher guard refuses an unknown verb
  // with the closest one, and the declared walk reaches `conventions doctor` —
  // a verdict verb, so a bad flag there exits 3, labelled with its own path.
  positionals: PositionalMode.None,
  subverbs: [
    {
      name: conventionsListCommand.name,
      description: conventionsListCommand.description,
      usage: conventionsListCommand.usage,
      positionals: PositionalMode.None,
    },
    {
      name: conventionsGetCommand.name,
      description: conventionsGetCommand.description,
      usage: conventionsGetCommand.usage,
      positionals: PositionalMode.Free,
    },
    {
      name: conventionsDoctorCommand.name,
      description: conventionsDoctorCommand.description,
      usage: conventionsDoctorCommand.usage,
      positionals: PositionalMode.None,
    },
    {
      name: conventionsCheckCommand.name,
      description: conventionsCheckCommand.description,
      usage: conventionsCheckCommand.usage,
      positionals: PositionalMode.None,
    },
    {
      name: conventionsExplainCommand.name,
      description: conventionsExplainCommand.description,
      usage: conventionsExplainCommand.usage,
      positionals: PositionalMode.Free,
    },
  ],
  // The group parses every subverb's argv, so the subverbs' boolean flags live here too.
  booleanFlags: new Set(['json', 'strict', 'staged', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    args.positional = args.positional.slice(1);
    if (sub === 'list') return conventionsListCommand.run(args);
    if (sub === 'get') return conventionsGetCommand.run(args);
    if (sub === 'doctor') return conventionsDoctorCommand.run(args);
    if (sub === 'check') return conventionsCheckCommand.run(args);
    if (sub === 'explain') return conventionsExplainCommand.run(args);
    process.stderr.write('Usage: shrk conventions list|get|doctor|check|explain ...\n');
    return 2;
  },
};
