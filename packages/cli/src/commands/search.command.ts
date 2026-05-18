import {
  buildSearchIndex,
  entrypointBanner,
  explainSearchTuning,
  inspectSharkcraft,
  loadConstructs,
  loadPlaybooks,
  loadSearchTuning,
  renderSearchText,
  renderTuningExplainHtml,
  renderTuningExplainMarkdown,
  searchIndex,
  SearchKind,
  SearchSource,
  type ISearchOptions,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  flagString,
  flagList,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

const VALID_KINDS = new Set(Object.values(SearchKind));
const VALID_SOURCES = new Set(Object.values(SearchSource));

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
  description:
    'Universal search across commands, MCP tools, knowledge, rules, paths, conventions, templates, helpers, playbooks, constructs, policies, decisions, scaffold patterns, contract templates, migration profiles, plugin lifecycle profiles, feedback rules, task routing hints, docs, recent reports. Default emits the 7-section unified output; pass --legacy for the flat output.',
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
    const { entries, issues } = await loadSearchTuning(inspection);
    if (sub === 'doctor') {
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson({ entries: entries.length, issues }) + '\n');
        return issues.some((i) => i.severity === 'error') ? 1 : 0;
      }
      process.stdout.write(`Tuning entries: ${entries.length}\n`);
      if (issues.length === 0) {
        process.stdout.write('No issues.\n');
        return 0;
      }
      for (const i of issues) {
        process.stdout.write(
          `  ${i.severity.toUpperCase().padEnd(8)} ${i.code.padEnd(20)} ${i.message}${i.tuningId ? `  (${i.tuningId})` : ''}\n`,
        );
      }
      return issues.some((i) => i.severity === 'error') ? 1 : 0;
    }
    // Default: list.
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(entries) + '\n');
      return 0;
    }
    process.stdout.write(`Search tuning (${entries.length} entries)\n`);
    for (const e of entries) {
      process.stdout.write(
        `  ${e.id.padEnd(36)} ${e.source}${e.packageName ? ` (${e.packageName})` : ''}\n`,
      );
    }
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

/**
 * Top-level `shrk search-tuning <verb>` alias.
 *
 * Lets users invoke `shrk search-tuning explain "<query>"` without
 * remembering the nested `shrk search tuning explain ...` form. Routes
 * directly through the existing handler to avoid drift.
 */
export const searchTuningTopLevelCommand: ICommandHandler = {
  name: 'search-tuning',
  description:
    'Alias — `shrk search-tuning <list|doctor|explain>` (delegates to `shrk search tuning ...`).',
  usage:
    'shrk search-tuning <list|doctor|explain> [<query>] [--kind <kind>] [--source <source>] [--limit N] [--format text|markdown|html|json]',
  async run(args: ParsedArgs): Promise<number> {
    return searchTuningListCommand.run(args);
  },
};
