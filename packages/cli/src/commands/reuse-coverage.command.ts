import { GraphQueryApi, detectGraphFreshness, detectWorkspacePackages } from '@shrkcrft/graph';
import {
  computeReuseCoverage,
  resolveProjectConfig,
  ReuseCuratedStatus,
  type IReuseCoverageReport,
  type IReuseCuratedCoverage,
} from '@shrkcrft/inspector';
import {
  ReuseMatchSource,
  ReuseNameMatch,
  UnfollowedReExportKind,
  type IReusePrimitive,
  type IUnfollowedReExport,
  type IVerdictCoverage,
} from '@shrkcrft/core';
import {
  firstUnknownFlag,
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { GLOBAL_FLAGS, IMPLICIT_FLAGS } from '../dispatch/global-flags.ts';
import { unknownFlagRefusal } from '../dispatch/unknown-flag-refusal.ts';
import { ExitCode } from '../exit-codes.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { buildGateEnvelope, type IGateRuleResult, type IGateViolation } from '../gates/gate-envelope.ts';
import { planeVerdictForExit } from '../gates/plane-verdict.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { graphReuseLookup } from '../graph/graph-reuse-lookup.ts';
import { asJson, header } from '../output/format-output.ts';

export const REUSE_COVERAGE_SCHEMA = 'sharkcraft.reuse-coverage/v1' as const;

const REUSE_COVERAGE_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'all',
  'include-types',
  'min-coverage',
  'package',
  'strict',
  ALLOW_EMPTY_FLAG,
  // Every dispatcher global (THE list) — a direct handler call may carry them.
  ...GLOBAL_FLAGS,
]);

const USAGE =
  'shrk reuse coverage [--json] [--all] [--include-types] [--min-coverage <pct>] [--package <name>[,<name>…]] [--strict] [--allow-empty]';

/** Hints per off-surface status: what to change so the entry is importable. */
const OFF_SURFACE_HINT: Partial<Record<ReuseCuratedStatus, string>> = {
  [ReuseCuratedStatus.ExportedNotPublic]:
    'Re-export it from its package entry, or point importPath at the module that exports it.',
  [ReuseCuratedStatus.NotExported]: 'Export it, or remove the entry.',
  [ReuseCuratedStatus.Ambiguous]: 'Set importPath so the entry names one declaration.',
};

/**
 * `shrk reuse coverage` — curated `reusePrimitives[]` vs the real public export
 * surface, so curation drift is a number instead of a silence.
 *
 * Every number comes from an existing authority: the surface from the graph
 * (`GraphQueryApi.publicExportSurface()`), freshness from
 * `detectGraphFreshness` (source files AND workspace package entries), each
 * curated entry's construct, import line and "would it compile?" from
 * `resolveCuratedReuse` (the record `shrk reuse` prints the row from), and
 * "is this a curation gap?" from the lookup's own ranker and gap predicate — so
 * this report and `shrk reuse` cannot disagree.
 *
 * Exit: 0 clean (curation gaps and off-surface entries are warnings) · 1 a dead
 * curated entry, an `importPath` that does not expose its symbol,
 * `--min-coverage` unmet, or `--strict` with any warning · 2 nothing measured
 * (no or stale index — a changed file or a changed package entry —, a package
 * with no resolved entry or a local re-export the index could not follow,
 * nothing to measure) · 3 usage.
 */
export const reuseCoverageCommand: ICommandHandler = {
  name: 'coverage',
  description:
    'Curated reusePrimitives[] vs the real public export surface: curated count against exported count, dead curated entries (symbol declared nowhere), importPaths that do not expose their symbol, curated entries no package entry exposes, and curation GAPS — exported names the reuse lookup answers with a different curated entry. NOT VERIFIED (exit 2) over a missing/stale graph index (a changed file or package.json entry) or a package whose exports were not fully walked. Read-only; no AI.',
  usage: USAGE,
  booleanFlags: new Set(['json', 'all', 'include-types', 'strict', ALLOW_EMPTY_FLAG]),
  async run(args: ParsedArgs): Promise<number> {
    const bad = firstUnknownFlag(args, REUSE_COVERAGE_FLAGS);
    if (bad !== undefined) {
      // THE one refusal format (round 13) — the dispatcher's own wording.
      const listed = [...REUSE_COVERAGE_FLAGS].filter((f) => !IMPLICIT_FLAGS.has(f));
      const refusal = unknownFlagRefusal({
        label: 'reuse coverage',
        flags: [bad],
        known: listed,
        accepts: listed,
        ...(args.argv !== undefined ? { argv: args.argv } : {}),
        exitCode: ExitCode.UsageError,
      });
      process.stderr.write(refusal.message);
      return refusal.exitCode;
    }
    if (args.positional.length > 0) {
      process.stderr.write(
        `'shrk reuse coverage' takes no positional argument (got "${args.positional[0]}"). Usage: ${USAGE}\n` +
          '  (To look up an intent that starts with the word "coverage", add words: shrk reuse "coverage chart widget".)\n',
      );
      return ExitCode.UsageError;
    }
    let minCoverage: number | undefined;
    if (args.flags.has('min-coverage')) {
      const raw = (flagString(args, 'min-coverage') ?? '').replace(/%$/, '').trim();
      const n = raw.length > 0 ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        process.stderr.write(`--min-coverage takes a percentage between 0 and 100 (got "${flagString(args, 'min-coverage') ?? ''}").\n`);
        return ExitCode.UsageError;
      }
      minCoverage = n;
    }
    let packageFilter: string[] | undefined;
    if (args.flags.has('package')) {
      const raw = flagString(args, 'package') ?? '';
      packageFilter = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (packageFilter.length === 0) {
        process.stderr.write('--package takes one or more workspace package names (comma-separated).\n');
        return ExitCode.UsageError;
      }
    }
    const cwd = resolveCwd(args);
    const wantJson = flagBool(args, 'json');
    const strict = flagBool(args, 'strict');

    const loaded = await resolveProjectConfig(cwd);
    if (!loaded.ok) {
      const msg = loaded.error.message;
      if (wantJson) {
        process.stdout.write(asJson({ schema: REUSE_COVERAGE_SCHEMA, error: msg, exitCode: ExitCode.UsageError }) + '\n');
      } else {
        process.stderr.write(`Could not load config: ${msg}\nRun \`shrk doctor\` for details.\n`);
      }
      return ExitCode.UsageError;
    }
    const primitives = loaded.value.config.reusePrimitives ?? [];
    if (packageFilter !== undefined) {
      // Validated against the workspace itself (the source the index's package
      // nodes come from), so a typo is a usage error even with no index — a
      // narrowing that names nothing must never read as "nothing to measure".
      const known = new Set(detectWorkspacePackages(cwd).map((p) => p.name));
      const unknown = packageFilter.filter((p) => !known.has(p));
      if (unknown.length > 0) {
        process.stderr.write(
          `Unknown workspace package(s) in --package: ${unknown.join(', ')}. Known: ${[...known].sort().join(', ') || '(none)'}.\n`,
        );
        return ExitCode.UsageError;
      }
    }

    // ── Freshness first: a number derived from a stale index is not printed. ──
    const fresh = detectGraphFreshness(cwd);
    if (!fresh.hasIndex) {
      return writeNotMeasured(args, primitives, wantJson, {
        why: 'no graph index',
        lead: 'There is no code-graph index (or it could not be read), so the public export surface was never measured — run `shrk graph index` and re-run.',
        coverage: {
          unit: 'graph index',
          expected: 1,
          examined: 0,
          reason: 'no graph index (or one that could not be read) — run `shrk graph index`',
        },
      });
    }
    const changed = [...fresh.modified, ...fresh.added, ...fresh.deleted];
    if (changed.length > 0) {
      return writeNotMeasured(args, primitives, wantJson, {
        why: `stale graph index (${changed.length} file(s) changed since it was built)`,
        lead: `The code-graph index is ${changed.length} file(s) behind, so every count and percentage derived from it would be stale — run \`shrk graph index\` and re-run.`,
        coverage: {
          unit: 'changed files',
          expected: changed.length,
          examined: 0,
          unexamined: changed.slice(0, 20),
          unexaminedTotal: changed.length,
          reason: 'not re-read since the graph index was built (run `shrk graph index`)',
        },
      });
    }
    // The package entries are the surface's ROOTS, and they come from
    // package.json — which no source-file fingerprint covers. A main/module/types
    // edit (or a package added/removed) moves the surface with every source file
    // byte-identical, so it is checked on its own.
    if (fresh.packagesChanged.length > 0) {
      const pkgs = fresh.packagesChanged;
      const shown = pkgs.slice(0, 5).join(', ') + (pkgs.length > 5 ? `, +${pkgs.length - 5} more` : '');
      return writeNotMeasured(args, primitives, wantJson, {
        why: `stale graph index (${pkgs.length} workspace package(s) changed since it was built)`,
        lead:
          `The workspace packages changed since the code-graph index was built (${shown}) — a package.json entry ` +
          '(main/module/types), the workspaces list, or a package added or removed — so the public surface the index ' +
          'records is stale. Run `shrk graph index` and re-run.',
        coverage: {
          unit: 'workspace packages',
          expected: pkgs.length,
          examined: 0,
          unexamined: pkgs.slice(0, 20),
          unexaminedTotal: pkgs.length,
          reason: 'changed since the graph index was built (a package.json entry, or the package set) — run `shrk graph index`',
        },
        details: { packagesChanged: pkgs },
      });
    }

    const api = GraphQueryApi.fromStore(cwd);
    const surface = api.publicExportSurface();
    const report = computeReuseCoverage(primitives, surface, graphReuseLookup(api), {
      includeTypes: flagBool(args, 'include-types'),
      all: flagBool(args, 'all'),
      ...(packageFilter !== undefined ? { packageFilter } : {}),
    });

    // ── One rule per curated entry (+ the --min-coverage bar) ─────────────
    const shadowsByAnswer = new Map<string, IReuseCoverageReport['shadowed'][number][]>();
    for (const s of report.shadowed) {
      const list = shadowsByAnswer.get(s.answeredBy);
      if (list) list.push(s);
      else shadowsByAnswer.set(s.answeredBy, [s]);
    }
    const rules: IGateRuleResult[] = report.curated.map((c) => {
      const violations: IGateViolation[] = [];
      let blocking = false;
      if (c.status === ReuseCuratedStatus.NotFound) {
        blocking = true;
        violations.push({
          id: c.symbol,
          message: `curated symbol ${c.symbol} is declared nowhere in the index — a dead entry every \`shrk reuse\` answer still recommends`,
          hint: 'Fix reusePrimitives[].symbol (a rename or a typo?) or remove the entry.',
        });
      }
      if (c.importPathAgrees === false) {
        blocking = true;
        violations.push({
          id: c.symbol,
          message: `importPath '${c.importPath}' does not expose ${c.symbol} — the import line \`shrk reuse\` prints would not compile`,
          ...(c.publicIn.length > 0 ? { hint: `It is exported by: ${c.publicIn.join(', ')}.` } : {}),
        });
      }
      const offSurface = isOffSurface(c);
      if (offSurface) {
        const hint = OFF_SURFACE_HINT[c.status];
        violations.push({
          id: c.symbol,
          message: `curated ${c.symbol} is ${c.status} — no workspace package entry exposes it, so the construct \`shrk reuse\` recommends cannot be imported from a package root`,
          ...(hint !== undefined ? { hint } : {}),
        });
      }
      const shadows = shadowsByAnswer.get(c.symbol) ?? [];
      for (const s of shadows) {
        violations.push({
          id: s.export,
          file: s.declaredIn,
          message: `curation gap: the reuse lookup answers ${c.symbol} (${gapHow(s)}) for the name of ${s.export}, which ${s.package} exports`,
          hint: `Add ${s.export} to reusePrimitives[], or list it in ${c.symbol}'s \`supersedes\`.`,
        });
      }
      const expected = 1 + (c.importPath !== undefined ? 1 : 0);
      const examined =
        (c.statusMeasured ? 1 : 0) + (c.importPath !== undefined && c.importPathNote === undefined ? 1 : 0);
      const notes = [c.statusNote, c.importPathNote].filter((n): n is string => n !== undefined);
      const coverage: IVerdictCoverage = {
        unit: 'checks',
        expected,
        examined,
        ...(notes.length > 0 ? { reason: notes.join('; ') } : {}),
      };
      // Advisory (a curation gap, an entry no package root exposes) — unless
      // `--strict` promotes warnings to failures.
      const advisory = shadows.length > 0 || offSurface;
      return {
        id: c.symbol,
        type: 'reuse',
        status: violations.length > 0 ? 'failed' : 'passed',
        severity: blocking || (strict && advisory) ? 'error' : advisory ? 'warning' : 'error',
        counts: { public: c.publicIn.length, consumers: c.consumers ?? 0 },
        violations,
        coverage,
      };
    });
    if (minCoverage !== undefined) {
      const met = report.ratioValue !== undefined && report.ratioValue * 100 >= minCoverage;
      rules.push({
        id: 'min-coverage',
        type: 'reuse',
        status: met ? 'passed' : 'failed',
        severity: 'error',
        counts: { curatedPublicValue: report.curatedPublicValue, value: report.surface.value },
        violations: met
          ? []
          : [
              {
                id: 'min-coverage',
                message:
                  report.ratioValue === undefined
                    ? `no value exports to measure a ratio over (--min-coverage ${minCoverage}%)`
                    : `coverage ${formatPct(report.ratioValue)} of value exports is below --min-coverage ${minCoverage}%`,
              },
            ],
        coverage: {
          unit: 'value exports',
          expected: report.surface.value,
          examined: report.surface.value,
          ...(report.surface.value === 0 ? { reason: 'no value exports to measure a ratio over' } : {}),
        },
      });
    }

    // ── Run coverage: the packages whose exports were FULLY walked ─────────
    // A package with no resolved entry was not walked at all; one whose walk met
    // a local re-export the index could not follow was walked only in part.
    const packagesInScope = report.surface.roots.length + report.surface.packagesWithoutEntry.length;
    const nothingToMeasure = report.curated.length === 0 && report.surface.all === 0;
    const noEntry = report.surface.packagesWithoutEntry.map((p) => p.package);
    const partlyWalked = localUnfollowedByPackage(report.surface.unfollowedReExports);
    const unexamined = [
      ...noEntry,
      ...[...partlyWalked].map(([pkg, list]) => `${pkg} (${describeUnfollowed(list)})`),
    ];
    const runCoverage: IVerdictCoverage = nothingToMeasure
      ? {
          unit: 'curated entries and public exports',
          expected: 0,
          examined: 0,
          reason: 'no curated reusePrimitives[] and no public export under a resolved package entry',
          ...allowEmptyValve(args, 0),
        }
      : {
          unit: 'workspace packages',
          expected: packagesInScope,
          examined: report.surface.roots.length - partlyWalked.size,
          ...(unexamined.length > 0
            ? {
                unexamined: unexamined.slice(0, 20),
                unexaminedTotal: unexamined.length,
                reason:
                  noEntry.length > 0 && partlyWalked.size > 0
                    ? 'have no resolved entry, or re-export a local module or name the index could not follow, so (part of) their exports were not measured'
                    : noEntry.length > 0
                      ? 'have no resolved entry, so their exports were not measured'
                      : 're-export a local module or name the index could not follow, so part of their exports was not measured',
              }
            : {}),
          ...(packagesInScope === 0 ? { reason: 'no workspace packages (package.json `workspaces`)' } : {}),
          ...allowEmptyValve(args, packagesInScope),
        };
    const blocking = rules.some((r) => r.status === 'failed' && r.severity === 'error');
    const proposed = blocking ? ExitCode.Failure : ExitCode.VerifiedPass;
    const env = buildGateEnvelope('reuse coverage', proposed, rules, runCoverage);
    const exit = env.exit;
    const warned = report.shadowed.length > 0 || report.curated.some(isOffSurface);

    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: REUSE_COVERAGE_SCHEMA,
          measured: true,
          ...report,
          ...(minCoverage !== undefined ? { minCoverage } : {}),
          exitCode: exit,
          verdict: planeVerdictForExit(exit, warned ? 'warnings' : undefined),
          gate: env,
        }) + '\n',
      );
      return exit;
    }

    writeReport(report, minCoverage);
    if (exit === ExitCode.NotVerified) {
      if (nothingToMeasure) {
        process.stdout.write(
          '\nNothing to measure: no curated reusePrimitives[] and no public exports.\n' +
            'Pass --allow-empty to accept an empty scope explicitly.\n',
        );
      } else if (packagesInScope === 0) {
        process.stdout.write(
          '\nNo workspace packages: there is no package root to measure a public surface from.\n' +
            'Pass --allow-empty to accept an empty scope explicitly.\n',
        );
      } else {
        if (noEntry.length > 0) {
          process.stdout.write(
            `\n${noEntry.length} workspace package(s) have no resolved entry, so their exports were NOT measured and every ratio above is partial —\n` +
              'give them an entry (package.json main, or src/index.ts), re-run `shrk graph index`, or narrow with --package.\n',
          );
        }
        if (partlyWalked.size > 0) {
          process.stdout.write(
            `\n${partlyWalked.size} workspace package(s) re-export a local module or name the index could not follow (listed above), so part of their exports was NOT measured —\n` +
              'fix the specifier (or make the target indexable), re-run `shrk graph index`, or narrow with --package.\n',
          );
        }
      }
    }
    const line = verdictLine(env, cleanSentence(report));
    if (line) process.stdout.write('\n' + line + '\n');
    return exit;
  },
};

/** How a gap's curated answer matched: a partial name hit, or metadata only. */
function gapHow(g: IReuseCoverageReport['shadowed'][number]): string {
  const via = g.matchedVia.filter((v) => v !== ReuseMatchSource.Symbol).join(', ');
  return g.nameMatch === ReuseNameMatch.Partial
    ? `only part of its name${via ? `, plus ${via}` : ''}`
    : `via ${via || 'metadata'} — not its name`;
}

/** A measured curated entry that exists but no package root exposes (a warning, not a dead entry). */
function isOffSurface(c: IReuseCuratedCoverage): boolean {
  return c.statusMeasured && c.status !== ReuseCuratedStatus.Public && c.status !== ReuseCuratedStatus.NotFound;
}

/**
 * The exit-0 sentence, built from the report. The ✓ is earned only when every
 * in-scope curated entry is public and nothing advisory was found — never over
 * an empty curated set, and never over entries the report just listed as off
 * the surface.
 */
function cleanSentence(report: IReuseCoverageReport): string {
  const qualifiers: string[] = [];
  if (report.shadowed.length > 0) qualifiers.push(`${report.shadowed.length} curation gap(s)`);
  const off = report.curated.filter((c) => c.status !== ReuseCuratedStatus.Public).length;
  if (off > 0) qualifiers.push(`${off} curated entr${off === 1 ? 'y' : 'ies'} not on the public surface`);
  if (report.curated.length === 0) {
    const scope = report.curatedOutOfScope > 0 ? ' in the --package scope' : '';
    return `No curated reusePrimitives[]${scope} — 0 of ${report.surface.value} value export(s) curated.`;
  }
  if (qualifiers.length > 0) return `No blocking reuse coverage problems — ${qualifiers.join(', ')} (listed above).`;
  return 'Every curated reuse entry resolves on the public surface. ✓';
}

/** Local (not external) unfollowed re-exports, grouped by the package whose walk met them. */
function localUnfollowedByPackage(unfollowed: readonly IUnfollowedReExport[]): Map<string, IUnfollowedReExport[]> {
  const out = new Map<string, IUnfollowedReExport[]>();
  for (const u of unfollowed) {
    if (u.kind !== UnfollowedReExportKind.Unresolved) continue;
    const list = out.get(u.package);
    if (list) list.push(u);
    else out.set(u.package, [u]);
  }
  return out;
}

function describeUnfollowed(list: readonly IUnfollowedReExport[]): string {
  const shown = list.slice(0, 2).map(formatUnfollowed).join(', ');
  return `${list.length} re-export(s) not followed: ${shown}${list.length > 2 ? `, +${list.length - 2} more` : ''}`;
}

function formatUnfollowed(u: IUnfollowedReExport): string {
  return `${u.file} → '${u.specifier}'${u.name === '*' ? ' (export *)' : ` { ${u.name} }`}`;
}

/** No (or a stale) index: every rule is skipped, no number is printed, exit settles to 2. */
function writeNotMeasured(
  args: ParsedArgs,
  primitives: readonly IReusePrimitive[],
  wantJson: boolean,
  o: { why: string; lead: string; coverage: IVerdictCoverage; details?: Record<string, unknown> },
): number {
  const rules: IGateRuleResult[] = primitives.map((p) => ({
    id: p.symbol,
    type: 'reuse',
    status: 'skipped',
    severity: 'error',
    counts: { public: 0, consumers: 0 },
    violations: [],
    skipReason: o.why,
    coverage: {
      unit: 'checks',
      expected: 1 + (p.importPath !== undefined ? 1 : 0),
      examined: 0,
      reason: o.why,
    },
  }));
  // Rule #4 of the keystone: propose 2 only when something SELECTED went
  // unexamined; an empty selection proposes 0 and the run coverage settles it.
  const proposed = rules.length > 0 ? ExitCode.NotVerified : ExitCode.VerifiedPass;
  const env = buildGateEnvelope('reuse coverage', proposed, rules, {
    ...o.coverage,
    ...allowEmptyValve(args, o.coverage.expected),
  });
  const exit = env.exit;
  if (wantJson) {
    process.stdout.write(
      asJson({
        schema: REUSE_COVERAGE_SCHEMA,
        measured: false,
        reason: o.why,
        ...(o.details ?? {}),
        curatedCount: primitives.length,
        exitCode: exit,
        verdict: planeVerdictForExit(exit),
        gate: env,
      }) + '\n',
    );
    return exit;
  }
  process.stdout.write(header('Reuse coverage'));
  process.stdout.write(
    `  curated ${primitives.length} · public exports NOT VERIFIED · coverage NOT VERIFIED — ${o.why}\n`,
  );
  // verdictLine already leads the NOT VERIFIED line with `o.lead`.
  const line = verdictLine(env, '', o.lead);
  if (line) process.stdout.write('\n' + line + '\n');
  return exit;
}

function writeReport(report: IReuseCoverageReport, minCoverage: number | undefined): void {
  const s = report.surface;
  const localUnfollowed = s.unfollowedReExports.filter((u) => u.kind === UnfollowedReExportKind.Unresolved);
  const partial = s.packagesWithoutEntry.length > 0 || localUnfollowed.length > 0 ? ' (partial)' : '';
  const ratio =
    report.ratioValue === undefined
      ? 'coverage n/a (no value exports)'
      : `coverage ${report.curatedPublicValue}/${s.value} value (${formatPct(report.ratioValue)})${partial}`;
  process.stdout.write(header('Reuse coverage'));
  process.stdout.write(
    `  curated ${report.curated.length} · public exports ${s.all} (value ${s.value}) · ${ratio} · ` +
      `${s.packagesWithoutEntry.length} package(s) without a resolved entry` +
      `${s.unfollowedReExports.length > 0 ? ` · ${s.unfollowedReExports.length} re-export(s) not followed` : ''}\n`,
  );
  if (report.curatedOutOfScope > 0) {
    process.stdout.write(`  (${report.curatedOutOfScope} curated entr${report.curatedOutOfScope === 1 ? 'y' : 'ies'} outside --package, not checked)\n`);
  }
  if (minCoverage !== undefined) process.stdout.write(`  --min-coverage ${minCoverage}%\n`);

  const dead = report.curated.filter((c) => c.status === ReuseCuratedStatus.NotFound);
  if (dead.length > 0) {
    process.stdout.write(`\nDead curated entries — the symbol is declared nowhere (${dead.length}):\n`);
    for (const c of dead) process.stdout.write(`  ✗ ${c.symbol}\n`);
  }
  const mismatched = report.curated.filter((c) => c.importPathAgrees === false);
  if (mismatched.length > 0) {
    process.stdout.write(`\nimportPath mismatches — the printed import would not compile (${mismatched.length}):\n`);
    for (const c of mismatched) {
      process.stdout.write(
        `  ✗ ${c.symbol} — '${c.importPath}' does not expose it${c.publicIn.length > 0 ? ` (exported by ${c.publicIn.join(', ')})` : ''}\n`,
      );
    }
  }
  const unverified = report.curated.filter((c) => c.statusNote !== undefined || c.importPathNote !== undefined);
  if (unverified.length > 0) {
    process.stdout.write(`\nNot verified (${unverified.length}):\n`);
    for (const c of unverified) {
      for (const n of [c.statusNote, c.importPathNote]) if (n) process.stdout.write(`  ~ ${c.symbol} — ${n}\n`);
    }
  }
  const offSurface = report.curated.filter(
    (c) => c.status !== ReuseCuratedStatus.Public && c.status !== ReuseCuratedStatus.NotFound,
  );
  if (offSurface.length > 0) {
    process.stdout.write(`\nCurated entries not on the public surface (${offSurface.length}):\n`);
    for (const c of offSurface) {
      process.stdout.write(`  • ${c.symbol} — ${c.status}${c.declaredIn.length > 0 ? ` (${c.declaredIn.join(', ')})` : ''}\n`);
    }
  }
  if (report.shadowed.length > 0) {
    process.stdout.write(
      `\nCuration gaps — an exported name the reuse lookup answers with a curated entry that names it only in part, or not at all (${report.shadowed.length}):\n`,
    );
    for (const g of report.shadowed) {
      process.stdout.write(`  ! ${g.export} (${g.package}) → answered by ${g.answeredBy} (${gapHow(g)})\n`);
    }
  }
  if (report.superseded.length > 0) {
    process.stdout.write(`\nSuperseded on purpose (${report.superseded.length}):\n`);
    for (const x of report.superseded) {
      process.stdout.write(`  • ${x.export} (${x.package}) → ${x.supersededBy.join(', ')}\n`);
    }
  }
  if (report.uncoveredTotal > 0) {
    const shown = report.uncovered.length;
    process.stdout.write(
      `\nUncovered public exports (${shown === report.uncoveredTotal ? report.uncoveredTotal : `${shown} of ${report.uncoveredTotal} shown; --all for every one`}):\n`,
    );
    for (const u of report.uncovered) process.stdout.write(`  • ${u.name}  (${u.package} · ${u.declKind})\n`);
  }
  if (s.packagesWithoutEntry.length > 0) {
    process.stdout.write(`\nPackages without a resolved entry — NOT measured (${s.packagesWithoutEntry.length}):\n`);
    for (const p of s.packagesWithoutEntry) process.stdout.write(`  ~ ${p.package} — ${p.reason}\n`);
  }
  if (s.unfollowedReExports.length > 0) {
    const external = s.unfollowedReExports.length - localUnfollowed.length;
    process.stdout.write(
      `\n${s.unfollowedReExports.length} re-export(s) not followed — ${localUnfollowed.length} local (part of the surface NOT measured), ${external} external (outside the workspace):\n`,
    );
    for (const u of s.unfollowedReExports.slice(0, 20)) {
      process.stdout.write(
        `  ${u.kind === UnfollowedReExportKind.Unresolved ? '~' : '•'} ${formatUnfollowed(u)} — ${u.kind} (${u.package})\n`,
      );
    }
    if (s.unfollowedReExports.length > 20) process.stdout.write(`  … +${s.unfollowedReExports.length - 20} more\n`);
  }
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}
