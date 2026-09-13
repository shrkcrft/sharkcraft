import {
  assetDoctorProposedExit,
  buildSearchIndex,
  ContributionKind,
  entrypointBanner,
  explainSearchTuning,
  inspectSharkcraft,
  lintSearchTuning,
  listSearchTuningIssues,
  loadConstructs,
  loadPlaybooks,
  loadSearchTuning,
  renderSearchText,
  renderTuningExplainHtml,
  renderTuningExplainMarkdown,
  searchIndex,
  SearchKind,
  SearchResultKind,
  SearchSource,
  settledUnitStates,
  type ISearchOptions,
} from '@shrkcrft/inspector';
import { usageExitFor } from '../exit-codes.ts';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { asJson } from '../output/format-output.ts';
import { writeRejectedEntriesNote } from '../output/rejected-entries-note.ts';
import { formatCoverage, type IVerdictCoverage } from '@shrkcrft/core';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { assetDoctorFailingUnits } from '../gates/asset-doctor-failing-units.ts';
import { assetDoctorFailureLine } from '../gates/asset-doctor-failure-line.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';

const VALID_KINDS = new Set(Object.values(SearchKind));
const VALID_SOURCES = new Set(Object.values(SearchSource));

// Universal-search (v2) filter vocabularies. `--kind` is one of the
// `SearchResultKind` enum values; `--source` is the local/pack origin the
// engine actually filters hits by (`makeHit` only ever emits these two). Both
// are validated up front so a typo'd value rejects loudly instead of silently
// filtering every hit out and returning an empty result with exit 0.
const VALID_RESULT_KINDS: readonly string[] = Object.values(SearchResultKind);
const VALID_RESULT_SOURCES: readonly string[] = ['local', 'pack'];

function parseKinds(args: ParsedArgs): readonly SearchKind[] | undefined {
  const list = flagList(args, 'type').concat(flagList(args, 'kind'));
  if (list.length === 0) return undefined;
  const out: SearchKind[] = [];
  for (const v of list) {
    if (VALID_KINDS.has(v as SearchKind)) out.push(v as SearchKind);
  }
  return out;
}

function parseSources(args: ParsedArgs): readonly SearchSource[] | undefined {
  const list = flagList(args, 'source');
  if (list.length === 0) return undefined;
  const out: SearchSource[] = [];
  for (const v of list) {
    if (VALID_SOURCES.has(v as SearchSource)) out.push(v as SearchSource);
  }
  return out;
}

export const searchCommand: ICommandHandler = {
  name: 'search',
  // The positionals are the free-form query; `tuning` is dispatched here.
  positionals: PositionalMode.Free,
  // The group parses every subverb's argv, so the doctor's boolean flags live
  // here too: none may swallow a following token. `search --fail-on-dead-units
  // tuning doctor` used to bind `tuning` as the flag's value and run a
  // universal search for "doctor" at exit 0 (round 13).
  booleanFlags: new Set([ALLOW_EMPTY_FLAG, 'fail-on-dead-units', 'strict', 'json']),
  subverbs: [
    {
      name: 'tuning',
      description: 'List, doctor, or explain the search-tuning entries (local + pack).',
      usage: 'shrk search tuning list|doctor|explain <query> [--format markdown|html|json]',
      // An unknown token used to fall through to the listing at exit 0.
      positionals: PositionalMode.None,
      subverbs: [
        { name: 'list', description: 'List the search-tuning entries (the default).', usage: 'shrk search tuning list [--format text|json]' },
        {
          name: 'doctor',
          description:
            'THE search-tuning lint plus the loader issues. A boost key whose target is missing is a dead unit (exit 2) unless its value is marked { weight, expectEmpty: true } (accepted, printed; reported once the target is registered).',
          usage: 'shrk search tuning doctor [--strict] [--fail-on-dead-units] [--allow-empty] [--format text|json]',
        },
        {
          name: 'explain',
          description: 'Which tunings move the top results of a query, and by how much.',
          usage: 'shrk search tuning explain <query> [--kind <kind>] [--source <source>] [--limit N] [--format markdown|html|json]',
          positionals: PositionalMode.Free,
        },
      ],
    },
  ],
  description:
    'Universal search across commands, MCP tools, knowledge, rules, paths, conventions, templates, helpers, playbooks, constructs, policies, decisions, scaffold patterns, contract templates, migration profiles, feedback rules, task routing hints, docs, recent reports. Default emits the 7-section unified output; pass --legacy for the flat output.',
  usage:
    'shrk search <query> [--kind <kind>] [--source local|pack|...] [--limit N] [--explain] [--commands-only] [--actions-only] [--format text|markdown|json] [--legacy]',
  async run(args: ParsedArgs): Promise<number> {
    // Sub-dispatch for `shrk search tuning [list|doctor]`.
    if (args.positional[0] === 'tuning') {
      const sliced: ParsedArgs = { ...args, positional: args.positional.slice(1) };
      return searchTuningListCommand.run(sliced);
    }
    const query = args.positional.join(' ').trim();
    if (!query) {
      process.stderr.write(
        'Usage: shrk search <query> [--kind ...] [--limit N] [--commands-only] [--actions-only] [--format text|markdown|json] | shrk search tuning [list|doctor]\n',
      );
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });

    // Universal search v2 is the default. Pass --legacy to get the
    // flat output.
    if (!flagBool(args, 'legacy')) {
      const {
        buildUniversalSearch,
        renderUniversalSearchText,
        renderUniversalSearchMarkdown,
      } = await import('@shrkcrft/inspector');
      const kindFilter = flagString(args, 'kind');
      const sourceFilter = flagString(args, 'source');
      // Validate the filter vocabularies BEFORE building opts — universal-search
      // silently drops every non-matching hit, so an unknown `--kind`/`--source`
      // would otherwise return an empty result with exit 0.
      if (kindFilter && !VALID_RESULT_KINDS.includes(kindFilter)) {
        process.stderr.write(
          `Unknown --kind ${kindFilter}. Valid: ${VALID_RESULT_KINDS.join(', ')}\n`,
        );
        return 2;
      }
      if (sourceFilter && !VALID_RESULT_SOURCES.includes(sourceFilter)) {
        process.stderr.write(
          `Unknown --source ${sourceFilter}. Valid: ${VALID_RESULT_SOURCES.join(', ')}\n`,
        );
        return 2;
      }
      const limit = flagNumber(args, 'limit');
      const opts: {
        kind?: unknown;
        source?: unknown;
        limit?: number;
        commandsOnly?: boolean;
        actionsOnly?: boolean;
      } = {};
      if (kindFilter) opts.kind = kindFilter;
      if (sourceFilter) opts.source = sourceFilter;
      if (limit) opts.limit = limit;
      if (flagBool(args, 'commands-only')) opts.commandsOnly = true;
      if (flagBool(args, 'actions-only')) opts.actionsOnly = true;
      const report = await buildUniversalSearch(inspection, query, opts as Parameters<typeof buildUniversalSearch>[2]);
      const format = flagString(args, 'format') ?? 'text';
      if (flagBool(args, 'json') || format === 'json') {
        process.stdout.write(asJson(report) + '\n');
        return 0;
      }
      if (format === 'markdown') {
        process.stdout.write(renderUniversalSearchMarkdown(report));
        return 0;
      }
      // Banner so the operator sees `search` is the registry-search
      // entrypoint, not "what should I do?".
      process.stdout.write(`(${entrypointBanner('search')})\n\n`);
      // Text mode is summary-only by default (top 3 of each non-empty
      // section). Pass `--verbose` / `--full` for the full 7-section bundle.
      const verbose = flagBool(args, 'verbose') || flagBool(args, 'full');
      if (verbose) {
        process.stdout.write(renderUniversalSearchText(report));
      } else {
        process.stdout.write(renderUniversalSearchSummary(report, flagNumber(args, 'top') ?? 3));
      }
      return 0;
    }

    // Warm registries so search includes constructs / playbooks / tuning.
    await loadConstructs(inspection);
    await loadPlaybooks(inspection);
    await loadSearchTuning(inspection);
    const index = buildSearchIndex(inspection);
    const opts: ISearchOptions = { query };
    const kinds = parseKinds(args);
    if (kinds) opts.kinds = kinds;
    const sources = parseSources(args);
    if (sources) opts.sources = sources;
    const limit = flagNumber(args, 'limit');
    if (limit) opts.limit = limit;
    if (flagBool(args, 'explain')) opts.explain = true;
    const result = searchIndex(index, opts, inspection);
    if (flagBool(args, 'json')) {
      // Stable serialization: convert the grouped Map to an object.
      const grouped: Record<string, unknown> = {};
      for (const [k, v] of result.grouped) grouped[k] = v;
      process.stdout.write(
        asJson({
          query: result.query,
          total: result.total,
          truncated: result.truncated,
          hits: result.hits,
          grouped,
        }) + '\n',
      );
      return 0;
    }
    // Same banner on the legacy text path.
    process.stdout.write(`(${entrypointBanner('search')})\n\n`);
    process.stdout.write(renderSearchText(result));
    return 0;
  },
};

export const searchTuningListCommand: ICommandHandler = {
  name: 'tuning',
  description: 'List, doctor, or explain search-tuning entries (local + pack).',
  usage: 'shrk search tuning list|doctor|explain <query> [--format markdown|html|json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    if (sub === 'explain') {
      const query = args.positional.slice(1).join(' ').trim();
      if (!query) {
        process.stderr.write('Usage: shrk search tuning explain <query> [--kind <kind>] [--source <source>] [--limit N] [--format markdown|html|json]\n');
        return 2;
      }
      const limit = flagNumber(args, 'limit');
      const kindFilter = flagString(args, 'kind');
      const sourceFilter = flagString(args, 'source');
      let report = await explainSearchTuning(
        inspection,
        query,
        typeof limit === 'number' ? { topN: limit } : {},
      );
      if (kindFilter) {
        report = { ...report, topResults: report.topResults.filter((r) => r.kind === kindFilter) };
      }
      if (sourceFilter) {
        report = {
          ...report,
          loadedTunings: report.loadedTunings.filter(
            (t) => t.source === sourceFilter || t.packageName === sourceFilter,
          ),
        };
      }
      const format = flagString(args, 'format') ?? (flagBool(args, 'json') ? 'json' : 'text');
      if (format === 'json') {
        process.stdout.write(asJson(report) + '\n');
        return 0;
      }
      if (format === 'markdown') {
        process.stdout.write(renderTuningExplainMarkdown(report));
        return 0;
      }
      if (format === 'html') {
        process.stdout.write(renderTuningExplainHtml(report));
        return 0;
      }
      // text default
      process.stdout.write(`Tuning explain for "${report.query}"\n`);
      process.stdout.write(`Tokens: ${report.tokens.join(', ') || '(none)'}\n`);
      process.stdout.write(`Loaded tunings: ${report.loadedTunings.length}\n`);
      for (const t of report.loadedTunings) {
        process.stdout.write(`  - ${t.id} (${t.source}${t.packageName ? '/' + t.packageName : ''})\n`);
      }
      if (report.topResults.length > 0) {
        process.stdout.write('Top deltas:\n');
        for (const r of report.topResults) {
          process.stdout.write(`  ${r.docId.padEnd(40)} ${r.baselineScore.toString().padStart(6)} → ${r.tunedScore.toString().padStart(6)} (Δ${r.delta})\n`);
          for (const reason of r.reasons.slice(0, 3)) process.stdout.write(`      ${reason}\n`);
        }
      } else {
        process.stdout.write('No matching tunings affect the top results.\n');
      }
      return 0;
    }
    if (sub === 'doctor') {
      // `--format` takes what the doctor can print: text or JSON. `--format
      // json` used to be ignored (text), and markdown / html were advertised
      // but never rendered — a usage error now, never a silent fallback.
      const format = flagString(args, 'format');
      if (format !== undefined && format !== 'text' && format !== 'json') {
        process.stderr.write(
          `'shrk search tuning doctor' --format takes text or json (got "${format}"). Run \`shrk help search\` for the flags it accepts.\n`,
        );
        return usageExitFor('search tuning doctor');
      }
      const wantJson = flagBool(args, 'json') || format === 'json';
      // THE search-tuning lint (shared with the self-config doctor) plus the
      // loader's own issues. It used to print "No issues." over a dead bare
      // key, a misspelled prefix, a missing target, triggers no query can
      // produce and a silent total-cap discard.
      const lint = await lintSearchTuning(inspection);
      const issues = [...listSearchTuningIssues(inspection), ...lint.issues];
      const errors = issues.filter((i) => i.severity === 'error').length;
      const warnings = issues.filter((i) => i.severity === 'warning').length;
      // THE asset-doctor proposal (round 13): errors, warnings under --strict,
      // and every settled unit THE --fail-on-dead-units predicate fails.
      const proposed = assetDoctorProposedExit(
        { errors, warnings, units: lint.liveness.flatMap((s) => s.units) },
        { strict: flagBool(args, 'strict'), failOnDeadUnits: flagBool(args, 'fail-on-dead-units') },
      );
      // Dead keys / triggers and unverifiable keys are coverage: never a pass.
      // No tuning declared examined nothing: NOT VERIFIED (2), like every other
      // asset doctor over an empty input, unless `--allow-empty` accepts it.
      const coverage: readonly IVerdictCoverage[] =
        lint.entries === 0
          ? [
              ...lint.coverage,
              {
                unit: 'search-tuning entries',
                expected: 0,
                examined: 0,
                reason: 'no search tuning declared',
                ...allowEmptyValve(args, 0),
              },
            ]
          : lint.coverage;
      const settled = settleVerdict(proposed, coverage);
      // THE units that fail this run (round 13 review) — printed and in
      // --json, so a 1 from --fail-on-dead-units is never silent about why.
      const failing = assetDoctorFailingUnits(lint.liveness.flatMap((s) => s.units), {
        failOnDeadUnits: flagBool(args, 'fail-on-dead-units'),
        strict: flagBool(args, 'strict'),
      });
      if (wantJson) {
        process.stdout.write(
          asJson({
            entries: lint.entries,
            failingUnits: failing.map((u) => ({ list: u.list, unit: u.unit, state: u.state, message: u.message })),
            issues,
            probes: lint.probes,
            coverage,
            deadUnits: lint.deadUnits,
            units: settledUnitStates(lint.liveness),
            exitCode: settled.exit,
            verdict: settled.verdict,
            shortfalls: settled.shortfalls,
            accepted: settled.accepted,
          }) + '\n',
        );
        return settled.exit;
      }
      const p = lint.probes;
      process.stdout.write(`Tuning entries: ${lint.entries}\n`);
      process.stdout.write(
        `Boost keys:     probed ${p.probed} · resolved ${p.resolved} · missing ${p.missing} · unprefixed ${p.unprefixed} · unknown-kind ${p.unknownKind} · unverified ${p.unverified}\n`,
      );
      for (const c of coverage) process.stdout.write(`Coverage:       ${formatCoverage(c)}\n`);
      for (const i of issues) {
        process.stdout.write(
          `  ${i.severity.toUpperCase().padEnd(8)} ${i.code.padEnd(22)} ${i.message}${i.tuningId ? `  (${i.tuningId})` : ''}\n`,
        );
      }
      // A stale LOCAL expectEmpty marker withholds the ✓ (a pack's is INFO).
      const keys = lint.liveness[0];
      const staleLocal = (keys?.wentLive ?? []).filter((u) => u.mark?.packageName === undefined).length;
      const clean =
        lint.entries === 0
          ? 'No search tuning declared — nothing to verify.'
          : warnings > 0
            ? `No blocking search-tuning issues — ${warnings} warning(s) reported above.`
            : staleLocal > 0
              ? `No blocking search-tuning issues — ${staleLocal} expectEmpty marker(s) went live (listed above; remove the markers).`
              : `Every boost key fires${(keys?.intendedEmpty.length ?? 0) > 0 ? ' or is intended empty' : ''} and every trigger is reachable. ✓`;
      const line = verdictLine(settled, clean);
      if (line) process.stdout.write(line + '\n');
      // Round 13 review: a 1 from --fail-on-dead-units names its units.
      if (settled.exit === 1) {
        const failure = assetDoctorFailureLine('search-tuning doctor', failing);
        if (failure) process.stdout.write(failure + '\n');
      }
      return settled.exit;
    }
    // Default: list. It renders text or JSON: a `--format` it cannot render is a
    // usage error, never a silent text fallback (round 13 review — its usage
    // advertised markdown / html, which printed the text listing at exit 0).
    const listFormat = flagString(args, 'format');
    if (listFormat !== undefined && listFormat !== 'text' && listFormat !== 'json') {
      process.stderr.write(
        `'shrk search tuning list' --format takes text or json (got "${listFormat}"). Run \`shrk help search\` for the flags it accepts.\n`,
      );
      return usageExitFor('search tuning list');
    }
    const { entries } = await loadSearchTuning(inspection);
    // A tuning entry its loader refused (no id) is named (round 12, 12.1).
    const note = { next: 'shrk search tuning doctor' };
    if (flagBool(args, 'json') || listFormat === 'json') {
      process.stdout.write(asJson(entries) + '\n');
      await writeRejectedEntriesNote(inspection, [ContributionKind.SearchTuning], { ...note, json: true });
      return 0;
    }
    process.stdout.write(`Search tuning (${entries.length} entries)\n`);
    for (const e of entries) {
      process.stdout.write(
        `  ${e.id.padEnd(36)} ${e.source}${e.packageName ? ` (${e.packageName})` : ''}\n`,
      );
    }
    await writeRejectedEntriesNote(inspection, [ContributionKind.SearchTuning], note);
    return 0;
  },
};

void flagString;

/**
 * Compact text renderer for the default `shrk search` output. Shows
 * up to `topN` items from each non-empty section, then a short "details:
 * pass --verbose" footer. Keeps the universal-search banner + confidence.
 */
function renderUniversalSearchSummary(
  report: {
    query: string;
    sections: {
      bestActions: ReadonlyArray<{
        kind: string;
        id: string;
        title: string;
        nextCommand?: string;
        action?: string;
        command?: string;
      }>;
      commands: ReadonlyArray<{ id: string; title: string; nextCommand?: string }>;
      contributions: ReadonlyArray<{ kind: string; id: string; title: string }>;
      knowledge: ReadonlyArray<{ id: string; title: string }>;
      validation: ReadonlyArray<{ id: string; title: string; nextCommand?: string }>;
    };
    uncertainty: { confidence: string; safeFallbackCommand: string };
  },
  topN: number,
): string {
  const lines: string[] = [];
  lines.push(`=== shrk search "${report.query}" (summary) ===`);
  lines.push('');
  const best = report.sections.bestActions.slice(0, topN);
  if (best.length > 0) {
    lines.push(`▶ Best actions (top ${best.length})`);
    for (const h of best) {
      const cmd = h.nextCommand ?? h.command ?? h.action ?? '';
      const inline = cmd ? `  →  ${cmd}` : '';
      lines.push(`   • ${h.title}${inline}`);
    }
    lines.push('');
  }
  const cmds = report.sections.commands.slice(0, topN);
  if (cmds.length > 0) {
    lines.push(`▶ Command matches (top ${cmds.length})`);
    for (const h of cmds) {
      const inline = h.nextCommand ? `  →  ${h.nextCommand}` : '';
      lines.push(`   • ${h.id} — ${h.title}${inline}`);
    }
    lines.push('');
  }
  const contrib = report.sections.contributions.slice(0, topN);
  if (contrib.length > 0) {
    lines.push(`▶ Pack contributions (top ${contrib.length})`);
    for (const h of contrib) lines.push(`   • [${h.kind}] ${h.id} — ${h.title}`);
    lines.push('');
  }
  const know = report.sections.knowledge.slice(0, topN);
  if (know.length > 0) {
    lines.push(`▶ Knowledge / docs (top ${know.length})`);
    for (const h of know) lines.push(`   • ${h.id} — ${h.title}`);
    lines.push('');
  }
  lines.push(
    `▶ Uncertainty: ${report.uncertainty.confidence.toUpperCase()} (safe fallback: ${report.uncertainty.safeFallbackCommand})`,
  );
  lines.push('');
  lines.push('(text mode is summary-only — pass --verbose / --full for the 7-section bundle, --json for machine output.)');
  return lines.join('\n') + '\n';
}
