/**
 * Top-level fuzzy `shrk trace <query>`.
 *
 * Accepts a free-form query (file path, construct id, plugin key, symbol,
 * helper id, template id, knowledge id, command name). Resolves via the
 * shared query resolver and prints structured trace output.
 */
import {
  findSymbolInProject,
  inspectSharkcraft,
  QueryMatchKind,
  resolveQuery,
  type IQueryMatch,
} from '@shrkcrft/inspector';
import {
  traceLiteral,
  TraceRole,
  type ITraceReport,
} from '@shrkcrft/boundaries';
import {
  flagBool,
  flagList,
  flagNumber,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

function describeMatch(m: IQueryMatch): string {
  return `${m.kind.padEnd(12)} ${m.id}${m.label && m.label !== m.id ? ` — ${m.label}` : ''} [${m.score.toFixed(0)}]`;
}

const LITERAL_SITE_CAP = 30;
const TRACE_ROLE_ORDER: readonly TraceRole[] = [
  TraceRole.Declare,
  TraceRole.Register,
  TraceRole.Consume,
  TraceRole.Reference,
];

function renderTraceLiteral(report: ITraceReport, limit: number): void {
  process.stdout.write(header(`Trace literal: "${report.literal}"`));
  process.stdout.write(kv('found', `${report.total} site(s) across ${report.files} file(s)`) + '\n');
  if (report.aliases.length > 0) {
    process.stdout.write(kv('const aliases', report.aliases.join(', ')) + '\n');
  }
  if (report.total === 0) {
    process.stdout.write('\nNo occurrences of that exact string literal in scope.\n');
    return;
  }
  // Mirror `shrk registry <name> where`'s `<role>  file:line` line idiom so the
  // two surfaces read the same — `trace literal` is the same scanner + classifier
  // without a pre-declared registry, just with two extra roles (`registered`,
  // `reference`). The raw source line stays in `--json` (`text`); the human view
  // is classification-first (direction), not a grep-style text dump.
  process.stdout.write('\n');
  for (const role of TRACE_ROLE_ORDER) {
    const sites = report.byRole[role];
    for (const s of sites.slice(0, limit)) {
      const alias = s.viaAlias ? ` [via ${s.viaAlias}]` : '';
      process.stdout.write(`  ${role.padEnd(10)} ${s.file}:${s.line}${alias}\n`);
    }
    if (sites.length > limit) {
      process.stdout.write(`  ${role.padEnd(10)} … (${sites.length - limit} more — pass --json)\n`);
    }
  }
}

/**
 * `shrk trace literal "<string>"`: trace an EXACT string literal across the
 * codebase, classified by direction (declare → register → consume), resolving
 * `const X = "lit"` aliases too. Generalizes `registry … where` to any
 * cross-fence string contract (a kind slug, permission id, route key) with no
 * pre-declared registry — the chain grep can't give (direction + role + layer).
 */
function runTraceLiteral(args: ParsedArgs): number {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  // `trace literal "<lit>"` → the literal is positional[1] (quoted by the user
  // so an internal space stays one token); join the rest defensively.
  const literal = args.positional.slice(1).join(' ');
  if (literal === '') {
    process.stderr.write(
      'Usage: shrk trace literal "<string>" [--glob <g1,g2>] [--no-aliases] [--limit N] [--json]\n',
    );
    return 2;
  }
  const globs = flagList(args, 'glob');
  const report = traceLiteral(cwd, literal, {
    ...(globs.length > 0 ? { globs } : {}),
    resolveAliases: !flagBool(args, 'no-aliases'),
  });
  if (wantJson) {
    process.stdout.write(asJson(report) + '\n');
    return 0;
  }
  const limitRaw = flagNumber(args, 'limit');
  const limit = limitRaw !== undefined && limitRaw > 0 ? Math.floor(limitRaw) : LITERAL_SITE_CAP;
  renderTraceLiteral(report, limit);
  return 0;
}

export const traceCommand: ICommandHandler = {
  name: 'trace',
  description:
    'Fuzzy trace — accept any free-form query (file path, construct id, symbol, plugin key, helper id, template id, knowledge id, command). `trace literal "<string>"` traces an exact string literal\'s declare→register→consume chain across layers (alias-resolved). Read-only.',
  usage:
    'shrk trace <query> | shrk trace literal "<string>" [--glob <g>] [--no-aliases] [--limit <n>] [--kind ...] [--deep] [--json]',
  booleanFlags: new Set(['json', 'deep', 'no-aliases']),
  async run(args: ParsedArgs): Promise<number> {
    // `trace literal "<lit>"` — cross-fence string-contract tracer (3.3).
    if (args.positional[0] === 'literal') return runTraceLiteral(args);
    // Direct symbol trace via --symbol <Name>
    const symbol = flagString(args, 'symbol');
    if (symbol) {
      const cwd = resolveCwd(args);
      const language = (flagString(args, 'language') ?? 'auto') as
        | 'auto' | 'typescript' | 'java' | 'csharp' | 'python' | 'go' | 'rust';
      const symReport = findSymbolInProject(cwd, symbol, { language });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(symReport) + '\n');
        return symReport.exactMatches.length > 0 ? 0 : 1;
      }
      process.stdout.write(header(`Trace symbol: ${symbol}`));
      if (symReport.exactMatches.length === 0) {
        process.stdout.write('  no exact-export or exact-local matches.\n');
        if (symReport.textMatches.length > 0) {
          process.stdout.write(`  ${symReport.textMatches.length} probable-text matches:\n`);
          for (const t of symReport.textMatches.slice(0, 8)) {
            process.stdout.write(`    • ${t.relativePath}\n`);
          }
        }
        process.stdout.write('\nNext commands:\n');
        process.stdout.write(`  shrk find "${symbol}"\n`);
        return 1;
      }
      for (const m of symReport.exactMatches) {
        process.stdout.write(`  ${m.resolution.padEnd(13)} ${m.relativePath}${m.line ? `:${m.line}` : ''}\n`);
      }
      if (symReport.primaryFile) {
        process.stdout.write(`\nPrimary file: ${symReport.primaryFile}\n`);
        process.stdout.write(`\nNext commands:\n`);
        process.stdout.write(`  shrk impact --symbol ${symbol}\n`);
        process.stdout.write(`  shrk impact ${symReport.primaryFile}\n`);
      } else {
        process.stdout.write(`\nAmbiguous — ${symReport.exactMatches.length} exact matches.\n`);
      }
      return 0;
    }
    const query = args.positional.join(' ').trim();
    if (!query) {
      process.stderr.write('Usage: shrk trace <query> | shrk trace --symbol <Name>\n');
      return 2;
    }
    // `--kind` restricts the result set to specific match kinds — the engine
    // (resolveQuery) filters by them. Validate up front so an unknown kind
    // fails fast with the valid list, instead of being silently ignored (which
    // returned a wrong-kind best match, e.g. a knowledge hit for
    // `--kind template`).
    const kinds = flagList(args, 'kind');
    const validKinds = new Set<string>(Object.values(QueryMatchKind));
    const unknownKind = kinds.find((k) => !validKinds.has(k));
    if (unknownKind) {
      process.stderr.write(
        `trace: unknown --kind "${unknownKind}". Valid kinds: ${[...validKinds].sort().join(', ')}.\n`,
      );
      return 2;
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const limit = flagNumber(args, 'limit');
    const resolution = resolveQuery(inspection, query, {
      ...(kinds.length > 0 ? { kinds: kinds as QueryMatchKind[] } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(resolution) + '\n');
      return resolution.bestMatch ? 0 : 1;
    }
    process.stdout.write(header(`Trace: ${query}`));
    if (!resolution.bestMatch) {
      process.stdout.write('  no matches found.\n');
      return 1;
    }
    process.stdout.write(`Confidence: ${resolution.confidence}\n`);
    process.stdout.write(`Best:    ${describeMatch(resolution.bestMatch)}\n`);
    if (resolution.bestMatch.reason) {
      process.stdout.write(`         reason: ${resolution.bestMatch.reason}\n`);
    }
    if (resolution.alternatives.length > 0) {
      process.stdout.write('Alternatives:\n');
      for (const alt of resolution.alternatives) {
        process.stdout.write(`  • ${describeMatch(alt)}\n`);
      }
    }
    if (flagBool(args, 'deep')) {
      const best = resolution.bestMatch;
      process.stdout.write('\nFollow-up commands:\n');
      if (best.kind === QueryMatchKind.Construct) {
        process.stdout.write(`  shrk constructs trace ${best.id} --deep\n`);
        process.stdout.write(`  shrk constructs impact ${best.id} --json\n`);
      } else if (best.kind === QueryMatchKind.File) {
        process.stdout.write(`  shrk impact ${best.id}\n`);
      } else if (best.kind === QueryMatchKind.Knowledge) {
        process.stdout.write(`  shrk knowledge get ${best.id}\n`);
      } else if (best.kind === QueryMatchKind.Template) {
        process.stdout.write(`  shrk templates get ${best.id}\n`);
        process.stdout.write(`  shrk templates preview ${best.id}\n`);
      } else if (best.kind === QueryMatchKind.Helper) {
        process.stdout.write(`  shrk helper get ${best.id}\n`);
        process.stdout.write(`  shrk helper plan ${best.id} --json\n`);
      } else if (best.kind === QueryMatchKind.Playbook) {
        process.stdout.write(`  shrk playbooks get ${best.id}\n`);
        process.stdout.write(`  shrk playbooks runbook ${best.id}\n`);
      } else if (best.kind === QueryMatchKind.Policy) {
        process.stdout.write(`  shrk policy get ${best.id}\n`);
      } else if (best.kind === QueryMatchKind.Command) {
        process.stdout.write(`  shrk commands get ${best.id}\n`);
      }
    }
    return 0;
  },
};
