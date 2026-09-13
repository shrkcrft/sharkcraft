/**
 * `shrk conventions ...` — pack/local conventions surface.
 *
 * Read-only listing + doctor + check. `check` runs the loaded conventions
 * against caller-supplied files (or git diff). Never writes.
 */
import type { IVerdictCoverage } from '@shrkcrft/core';
import {
  checkConventionsAgainstFiles,
  ContributionKind,
  findConvention,
  getChangedFiles,
  inspectSharkcraft,
  listConventions,
  loadConventions,
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

export const conventionsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List registered conventions. Read-only.',
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
      process.stdout.write(asJson(filtered) + '\n');
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
    }
    writeListVerbNote(outcomes, inspection.projectRoot, note);
    return 0;
  },
};

export const conventionsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show a single convention by id.',
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
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entry) + '\n');
      return 0;
    }
    const c = entry.convention;
    process.stdout.write(header(`Convention ${c.id} (${c.kind})`));
    process.stdout.write(`  title         ${c.title}\n`);
    if (c.description) process.stdout.write(`  description   ${c.description}\n`);
    process.stdout.write(`  severity      ${c.severity}\n`);
    process.stdout.write(`  source        ${entry.source}${entry.packageName ? ' (' + entry.packageName + ')' : ''}\n`);
    process.stdout.write(`  sourceFile    ${entry.sourceFile}\n`);
    process.stdout.write(`  rules (${c.rules.length}):\n`);
    for (const r of c.rules) {
      process.stdout.write(`    • ${r.id}  ${r.description}\n`);
    }
    if (c.examples && c.examples.length > 0) {
      process.stdout.write(`  examples (${c.examples.length}):\n`);
      for (const e of c.examples) process.stdout.write(`    • ${e.description}\n`);
    }
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
    'Run the loaded conventions against files (--files / --since / --staged; default: the working-tree change). Exit 0 no error-severity hit · 1 an error-severity hit · 2 NOT VERIFIED — no file in scope, no convention declared (--allow-empty accepts either explicitly), or a convention file never read · 3 usage. Read-only.',
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
      files = getChangedFiles(cwd, { staged: true });
      scope = 'the staged change';
    } else {
      const since = flagString(args, 'since');
      files = since ? getChangedFiles(cwd, { since }) : getChangedFiles(cwd, {});
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
        const hits = report.hits.filter((h) => h.conventionId === e.convention.id);
        return {
          id: e.convention.id,
          type: 'convention',
          status: hits.some((h) => h.severity === 'error') ? 'failed' : 'passed',
          severity: e.convention.severity === 'error' ? 'error' : 'warning',
          counts: { rules: e.convention.rules.length, hits: hits.length },
          violations: hits.map((h) => ({ id: `${h.conventionId}/${h.ruleId}`, file: h.file, message: h.message })),
          coverage: { unit: 'conventions', expected: 1, examined: 1 },
        };
      }),
    ];
    const gate = buildGateEnvelope(
      'conventions check',
      report.verdict === 'clean' ? ExitCode.VerifiedPass : ExitCode.Failure,
      rows,
      {
        unit: 'files',
        expected: files.length,
        examined: files.length,
        root: inspection.projectRoot,
        reason: `no file in ${scope} — nothing to check the conventions against`,
        ...allowEmptyValve(args, files.length),
      },
    );
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          ...report,
          // The engine's `clean` over an empty scope is not a pass (round 13
          // review): at 2 the top-level verdict says so, never contradicting
          // `exitCode` / `gate.verdict` beside it.
          verdict: gate.exit === ExitCode.NotVerified ? 'not-verified' : report.verdict,
          conventions: loaded.entries.length,
          exitCode: gate.exit,
          shortfalls: gate.shortfalls,
          accepted: gate.accepted,
          gate,
        }) + '\n',
      );
      return gate.exit;
    }
    process.stdout.write(header(`Convention check (${report.filesScanned} files, ${report.hits.length} hits)`));
    for (const h of report.hits.slice(0, 200)) {
      process.stdout.write(`  ${h.severity.padEnd(7)} ${h.conventionId}/${h.ruleId} — ${h.file}\n`);
      process.stdout.write(`           ${h.message}\n`);
    }
    const empty = files.length === 0 || loaded.files.discovered === 0;
    const warnings = report.hits.filter((h) => h.severity !== 'error').length;
    const clean = empty
      ? 'Nothing to check — accepted.'
      : warnings > 0
        ? `No blocking convention violation — ${warnings} non-error hit(s) reported above.`
        : 'ok — no violations.';
    const line = verdictLine(gate, clean);
    if (line) process.stdout.write(`\n${line}\n`);
    if (gate.exit === ExitCode.NotVerified && empty) {
      process.stdout.write(
        `Pass --${ALLOW_EMPTY_FLAG} to accept an empty changeset or a project with no conventions explicitly.\n`,
      );
    }
    return gate.exit;
  },
};

export const conventionsExplainCommand: ICommandHandler = {
  name: 'explain',
  description: 'Explain a convention (description + rules + examples + references).',
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
