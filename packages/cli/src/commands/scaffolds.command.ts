import {
  assetDoctorProposedExit,
  buildScaffoldPatternDoctorReport,
  collectKindRejections,
  ContributionKind,
  contributionFileLabel,
  formatEntryRejection,
  inspectSharkcraft,
  loadScaffoldPatternsFromInspection,
  settledUnitStates,
} from '@shrkcrft/inspector';
import { formatCoverage } from '@shrkcrft/core';
import {
  flagBool,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { rejectedEntriesNote } from '../output/rejected-entries-note.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { assetDoctorFailingUnits } from '../gates/asset-doctor-failing-units.ts';
import { assetDoctorFailureLine } from '../gates/asset-doctor-failure-line.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';

export const scaffoldsListCommand: ICommandHandler = {
  name: 'list',
  description: 'List every scaffold pattern contributed by an installed pack.',
  usage: 'shrk scaffolds list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const result = await loadScaffoldPatternsFromInspection(inspection);
    // THE rejection channel (round 12, 12.1): a pattern the loader refused
    // (no templateId / matchPaths / confidence, a duplicate id) is a record
    // with every reason — it used to be a raw `! …` warning string.
    const rejected = await collectKindRejections(inspection, [ContributionKind.ScaffoldPattern]);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          patterns: result.patterns.map((p) => ({
            id: p.pattern.id,
            title: p.pattern.title,
            templateId: p.pattern.templateId,
            confidence: p.pattern.confidence,
            matchPaths: p.pattern.matchPaths,
            ...(p.pattern.expectEmptyUnits ? { expectEmptyUnits: p.pattern.expectEmptyUnits } : {}),
            appliesWhen: p.pattern.appliesWhen,
            source: p.source,
          })),
          warnings: result.warnings,
          rejected: rejected.map((r) => ({ ...r, file: contributionFileLabel(inspection.projectRoot, r.file) })),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header(`Scaffold patterns (${result.patterns.length})`));
    for (const p of result.patterns) {
      process.stdout.write(
        `  • ${p.pattern.id.padEnd(36)} ${String(p.pattern.confidence).padEnd(7)} → ${p.pattern.templateId}\n`,
      );
      process.stdout.write(`      ${p.pattern.title ?? ''}\n`);
      process.stdout.write(`      source: ${p.source.packageName ?? p.source.type}\n`);
    }
    if (result.warnings.length > 0) {
      // File-level problems (missing, not an array, failed to import).
      process.stdout.write('\nWarnings:\n');
      for (const w of result.warnings) process.stdout.write(`  ! ${w}\n`);
    }
    if (result.patterns.length === 0) {
      process.stdout.write('\nNo scaffold patterns found. Packs can contribute them via `scaffoldPatternFiles`.\n');
    }
    const note = rejectedEntriesNote(rejected, inspection.projectRoot, 'shrk scaffolds doctor');
    if (note) process.stdout.write(`\n${note}`);
    return 0;
  },
};

export const scaffoldsGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show one scaffold pattern (full content).',
  usage: 'shrk scaffolds get <id> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk scaffolds get <id>\n');
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const result = await loadScaffoldPatternsFromInspection(inspection);
    const match = result.patterns.find((p) => p.pattern.id === id);
    if (!match) {
      process.stderr.write(`Unknown scaffold pattern: "${id}"\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(match) + '\n');
      return 0;
    }
    process.stdout.write(header(`Scaffold pattern: ${match.pattern.id}`));
    process.stdout.write(kv('title', match.pattern.title) + '\n');
    process.stdout.write(kv('templateId', match.pattern.templateId) + '\n');
    process.stdout.write(kv('confidence', match.pattern.confidence) + '\n');
    process.stdout.write(kv('source', match.source.packageName ?? match.source.type) + '\n');
    process.stdout.write(`\nMatch paths:\n`);
    const marked = new Map((match.pattern.expectEmptyUnits ?? []).map((m) => [m.unit, m]));
    for (const m of match.pattern.matchPaths) {
      const mark = marked.get(m);
      process.stdout.write(`  - ${m}${mark ? `  (expectEmpty${mark.reason ? `: ${mark.reason}` : ''})` : ''}\n`);
    }
    process.stdout.write(`\nApplies when:\n`);
    for (const a of match.pattern.appliesWhen) process.stdout.write(`  - ${a}\n`);
    process.stdout.write(`\nVariables:\n`);
    for (const v of match.pattern.variables) process.stdout.write(`  • ${v.name}  from=${String(v.from)}\n`);
    return 0;
  },
};

export const scaffoldsDoctorCommand: ICommandHandler = {
  name: 'doctor',
  description:
    'Validate scaffold pattern definitions (templates exist, strategies recognized, …) and count the files every matchPaths glob matches — a glob or pattern matching nothing is a dead unit (exit 2), unless the glob is marked { pattern, expectEmpty: true } (accepted, printed; reported once a file matches).',
  usage: 'shrk scaffolds doctor [--json] [--strict] [--fail-on-dead-units] [--allow-empty]',
  booleanFlags: new Set(['json', 'strict', 'fail-on-dead-units', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    // THE scaffold-pattern doctor (round 13) — MCP get_scaffold_pattern_doctor
    // reads the same report. No pattern declared examined nothing: NOT VERIFIED
    // (2), like every other asset doctor over an empty input, unless
    // `--allow-empty` accepts it (printed).
    const report = await buildScaffoldPatternDoctorReport(inspection, allowEmptyValve(args, 0));
    const proposed = assetDoctorProposedExit(
      { errors: report.errors, warnings: report.warnings, units: report.measured.liveness.flatMap((s) => s.units) },
      { strict: flagBool(args, 'strict'), failOnDeadUnits: flagBool(args, 'fail-on-dead-units') },
    );
    const settled = settleVerdict(proposed, report.coverage);
    const deadUnits = report.measured.deadUnits;
    // THE units that fail this run (round 13 review) — printed and in --json,
    // so a 1 from --fail-on-dead-units is never silent about why.
    const failing = assetDoctorFailingUnits(report.measured.liveness.flatMap((s) => s.units), {
      failOnDeadUnits: flagBool(args, 'fail-on-dead-units'),
      strict: flagBool(args, 'strict'),
    });
    const rejected = report.rejected.map((r) => ({ ...r, file: contributionFileLabel(inspection.projectRoot, r.file) }));
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          patterns: report.patterns.length,
          failingUnits: failing.map((u) => ({ list: u.list, unit: u.unit, state: u.state, message: u.message })),
          errors: report.errors,
          warnings: report.warnings,
          dead: deadUnits.length,
          issues: report.issues,
          loadWarnings: report.loadWarnings,
          rejected,
          patternCoverage: report.patternCoverage,
          coverage: report.coverage,
          deadUnits,
          units: settledUnitStates(report.measured.liveness),
          exitCode: settled.exit,
          verdict: settled.verdict,
          shortfalls: settled.shortfalls,
          accepted: settled.accepted,
        }) + '\n',
      );
      return settled.exit;
    }
    process.stdout.write(header('Scaffold pattern doctor'));
    process.stdout.write(kv('patterns', report.patterns.length.toString()) + '\n');
    process.stdout.write(kv('errors', report.errors.toString()) + '\n');
    process.stdout.write(kv('warnings', report.warnings.toString()) + '\n');
    process.stdout.write(kv('dead', deadUnits.length.toString()) + '\n');
    for (const c of report.coverage) process.stdout.write(kv('coverage', formatCoverage(c)) + '\n');
    if (report.issues.length > 0) {
      process.stdout.write('\nIssues:\n');
      for (const i of report.issues) {
        const tag = i.severity === 'error' ? 'ERR ' : i.severity === 'warning' ? 'WARN' : 'INFO';
        process.stdout.write(`  ${tag}  ${i.patternId.padEnd(28)} ${i.field.padEnd(20)} ${i.message}\n`);
      }
    }
    if (report.rejected.length > 0) {
      process.stdout.write('\nRejected entries (refused by the loader — NOT in effect):\n');
      for (const r of report.rejected) {
        process.stdout.write(`  ERR   ${contributionFileLabel(inspection.projectRoot, r.file)}  ${formatEntryRejection(r)}\n`);
      }
    }
    if (report.loadWarnings.length > 0) {
      process.stdout.write('\nLoad warnings:\n');
      for (const w of report.loadWarnings) process.stdout.write(`  ! ${w}\n`);
    }
    // A stale LOCAL expectEmpty marker withholds the ✓ (a pack's is INFO).
    const globs = report.measured.liveness[0];
    const staleLocal = (globs?.wentLive ?? []).filter((u) => u.mark?.packageName === undefined).length;
    const intendedEmpty = globs?.intendedEmpty.length ?? 0;
    const clean =
      report.patterns.length === 0
        ? 'No scaffold patterns declared — nothing to verify.'
        : report.warnings > 0
          ? `No blocking scaffold-pattern issues — ${report.warnings} warning(s) reported above.`
          : staleLocal > 0
            ? `No blocking scaffold-pattern issues — ${staleLocal} expectEmpty marker(s) went live (listed above; remove the markers).`
            : `${report.patterns.length} pattern(s) valid; every matchPaths glob matches a file${intendedEmpty > 0 ? ' or is intended empty' : ''}. ✓`;
    const line = verdictLine(settled, clean);
    if (line) process.stdout.write('\n' + line + '\n');
    // Round 13 review: a 1 from --fail-on-dead-units names its units.
    if (settled.exit === 1) {
      const failure = assetDoctorFailureLine('scaffold-pattern doctor', failing);
      if (failure) process.stdout.write('\n' + failure + '\n');
    }
    return settled.exit;
  },
};
