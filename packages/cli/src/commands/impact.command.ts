import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  analyzeImpact,
  analyzeTestImpact,
  findSymbolInProject,
  FuzzyImpactSourceKind,
  getChangedFiles,
  ImpactInputKind,
  inspectSharkcraft,
  QueryMatchKind,
  readFeatureBundle,
  renderImpactGraph,
  renderImpactHtml,
  renderImpactMarkdown,
  renderImpactText,
  resolveFuzzyImpact,
  warmConstructCache,
  type IFuzzyImpactResolution,
  type IImpactAnalysis,
  type ImpactGraphFormat,
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
import { asJson, header, kv } from '../output/format-output.ts';
import { fuzzyImpactAmbiguousHints, renderFailureHints } from '../output/failure-hints.ts';
import { computeDeletedOrphans } from '../diff/deleted-orphans.ts';

function collectFiles(
  args: ParsedArgs,
  cwd: string,
): {
  files: string[];
  planTargets: string[];
  kind: ImpactInputKind;
  specifier?: string;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const explicitFiles = flagList(args, 'files');
  const fileFlag = flagString(args, 'file');
  const specifier = flagString(args, 'specifier');
  const sinceRef = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const planFile = flagString(args, 'plan');
  const bundleId = flagString(args, 'bundle');
  const files: string[] = [];
  const planTargets: string[] = [];
  const seenKinds = new Set<ImpactInputKind>();

  if (fileFlag) {
    files.push(fileFlag);
    seenKinds.add(ImpactInputKind.File);
  }
  if (explicitFiles.length > 0) {
    files.push(...explicitFiles);
    seenKinds.add(ImpactInputKind.Files);
  }
  if (sinceRef) {
    const changed = getChangedFiles(cwd, { since: sinceRef });
    files.push(...changed);
    if (changed.length === 0) diagnostics.push(`no files changed since ${sinceRef}`);
    seenKinds.add(ImpactInputKind.Since);
  }
  if (staged) {
    const changed = getChangedFiles(cwd, { staged: true });
    files.push(...changed);
    if (changed.length === 0) diagnostics.push('no staged changes');
    seenKinds.add(ImpactInputKind.Staged);
  }
  if (planFile) {
    const abs = nodePath.isAbsolute(planFile) ? planFile : nodePath.join(cwd, planFile);
    if (!existsSync(abs)) {
      diagnostics.push(`plan file not found: ${planFile}`);
    } else {
      try {
        const parsed = JSON.parse(readFileSync(abs, 'utf8')) as {
          changes?: readonly { relativePath?: string }[];
          plan?: { changes?: readonly { relativePath?: string }[] };
        };
        const changes = parsed.changes ?? parsed.plan?.changes ?? [];
        for (const c of changes) if (c.relativePath) planTargets.push(c.relativePath);
        seenKinds.add(ImpactInputKind.Plan);
      } catch (e) {
        diagnostics.push(`failed to read plan: ${(e as Error).message}`);
      }
    }
  }
  if (bundleId) {
    const bundle = readFeatureBundle(cwd, bundleId);
    if (!bundle) {
      diagnostics.push(`bundle "${bundleId}" not found`);
    } else {
      for (const f of bundle.affectedFiles) files.push(f);
      for (const p of bundle.plans) for (const t of p.expectedTargets) planTargets.push(t);
      seenKinds.add(ImpactInputKind.Bundle);
    }
  }

  // Positional support: shrk impact <fileOrSpecifier>
  if (
    args.positional.length > 0 &&
    !specifier &&
    !fileFlag &&
    explicitFiles.length === 0 &&
    !sinceRef &&
    !staged &&
    !planFile &&
    !bundleId
  ) {
    const arg = args.positional[0]!;
    if (arg.startsWith('@') || /^[a-z]+:/i.test(arg)) {
      // Looks like an import specifier.
      const out: { files: string[]; planTargets: string[]; kind: ImpactInputKind; specifier: string; diagnostics: string[] } = {
        files: [],
        planTargets: [],
        kind: ImpactInputKind.Specifier,
        specifier: arg,
        diagnostics,
      };
      return out;
    }
    files.push(arg);
    seenKinds.add(ImpactInputKind.File);
  }

  let kind: ImpactInputKind = ImpactInputKind.Empty;
  if (specifier) kind = ImpactInputKind.Specifier;
  else if (seenKinds.size > 1) kind = ImpactInputKind.Mixed;
  else if (seenKinds.size === 1) kind = [...seenKinds][0]!;

  const out: { files: string[]; planTargets: string[]; kind: ImpactInputKind; specifier?: string; diagnostics: string[] } = {
    files: [...new Set(files)],
    planTargets: [...new Set(planTargets)],
    kind,
    diagnostics,
  };
  if (specifier) out.specifier = specifier;
  return out;
}

/**
 * Codemod-handoff plan. SharkCraft is not a codemod engine; the
 * `impact --plan-format codemod` emits a stable JSON that external tools
 * (jscodeshift, ts-morph) or humans can consume. The starter template is
 * dialect-aware but contains TODO bodies only — the engine never writes
 * runnable codemod logic.
 */
interface ICodemodPlan {
  schema: 'sharkcraft.codemod-plan/v1';
  generatedAt: string;
  format: 'codemod' | 'ts-morph' | 'jscodeshift';
  task: string;
  affectedFiles: readonly string[];
  symbols: readonly string[];
  riskGroups: ReadonlyArray<{ risk: string; files: readonly string[] }>;
  suggestedOperationCategories: readonly string[];
  safeNotes: readonly string[];
  unsafeNotes: readonly string[];
  testRecommendations: readonly string[];
  codemodStarterMetadata: {
    language: 'typescript';
    dialect: 'codemod' | 'ts-morph' | 'jscodeshift';
    starterPath: string | null;
  };
}

const VALID_PLAN_FORMATS = new Set(['codemod', 'ts-morph', 'jscodeshift']);

function tsMorphStarter(plan: ICodemodPlan): string {
  return `// Codemod starter (ts-morph dialect). TODO bodies only — humans/external\n// tools fill the operations in. Affected files / symbols are pinned by\n// the impact analysis at generation time.\n//\n// Task: ${plan.task || '(unspecified)'}\n//\n// Usage:\n//   bun add -d ts-morph\n//   bun run codemod.ts\n\nimport { Project } from 'ts-morph';\n\nconst project = new Project({ tsConfigFilePath: 'tsconfig.base.json' });\n\nconst affectedFiles = ${JSON.stringify(plan.affectedFiles, null, 2)};\nconst symbols = ${JSON.stringify(plan.symbols, null, 2)};\n\nfor (const relPath of affectedFiles) {\n  const sourceFile = project.getSourceFile(relPath);\n  if (!sourceFile) continue;\n  // TODO: apply operations for symbols ${plan.symbols.join(', ') || '(none)'}\n}\n\nproject.saveSync();\n`;
}

function jscodeshiftStarter(plan: ICodemodPlan): string {
  return `// Codemod starter (jscodeshift dialect). TODO bodies only.\n//\n// Task: ${plan.task || '(unspecified)'}\n//\n// Usage:\n//   bun add -d jscodeshift\n//   bunx jscodeshift -t codemod.ts <files>\n\nimport type { Transform } from 'jscodeshift';\n\nconst affectedFiles = ${JSON.stringify(plan.affectedFiles, null, 2)};\nconst symbols = ${JSON.stringify(plan.symbols, null, 2)};\n\nconst transform: Transform = (file, api) => {\n  const j = api.jscodeshift;\n  const root = j(file.source);\n  // TODO: apply operations for symbols ${plan.symbols.join(', ') || '(none)'}\n  return root.toSource();\n};\n\nexport default transform;\n`;
}

function plainStarter(plan: ICodemodPlan): string {
  return `// Codemod handoff (no specific dialect). This file is a checklist.\n//\n// Task: ${plan.task || '(unspecified)'}\n//\n// Affected files (${plan.affectedFiles.length}):\n${plan.affectedFiles.map((f) => `//   - ${f}`).join('\n') || '//   (none)'}\n//\n// Symbols of interest:\n${plan.symbols.map((s) => `//   - ${s}`).join('\n') || '//   (none)'}\n//\n// Operation categories: ${plan.suggestedOperationCategories.join(', ') || '(none)'}\n//\n// Safety notes:\n${plan.safeNotes.map((n) => `//   - ${n}`).join('\n')}\n//\n// Pre-merge checks:\n${plan.testRecommendations.map((t) => `//   - $ ${t}`).join('\n')}\n`;
}

async function emitCodemodPlan(opts: {
  readonly cwd: string;
  readonly analysis: {
    risks?: ReadonlyArray<{ severity: string; relativePath?: string; message?: string }>;
    direct?: ReadonlyArray<{ relativePath: string }>;
    transitive?: ReadonlyArray<{ relativePath: string }>;
    targets?: ReadonlyArray<{ relativePath: string }>;
    diagnostics?: readonly string[];
  };
  readonly format: string;
  readonly writeStarter: boolean;
  readonly task?: string;
  readonly output?: string;
}): Promise<number> {
  if (!VALID_PLAN_FORMATS.has(opts.format)) {
    process.stderr.write(
      `Unknown --plan-format "${opts.format}". Use codemod | ts-morph | jscodeshift.\n`,
    );
    return 2;
  }
  const dialect = opts.format as 'codemod' | 'ts-morph' | 'jscodeshift';

  const collectFiles = (xs?: ReadonlyArray<{ relativePath: string }>): string[] =>
    (xs ?? []).map((x) => x.relativePath).filter((s): s is string => typeof s === 'string');
  const affectedFiles = Array.from(
    new Set([
      ...collectFiles(opts.analysis.targets),
      ...collectFiles(opts.analysis.direct),
      ...collectFiles(opts.analysis.transitive),
    ]),
  );

  const riskGroupsMap = new Map<string, string[]>();
  for (const r of opts.analysis.risks ?? []) {
    const arr = riskGroupsMap.get(r.severity) ?? [];
    if (r.relativePath) arr.push(r.relativePath);
    riskGroupsMap.set(r.severity, arr);
  }
  const riskGroups = [...riskGroupsMap.entries()].map(([risk, files]) => ({
    risk,
    files,
  }));

  let starterPath: string | null = null;
  let starterBody: string | null = null;
  const plan: ICodemodPlan = {
    schema: 'sharkcraft.codemod-plan/v1',
    generatedAt: new Date().toISOString(),
    format: dialect,
    task: opts.task ?? '',
    affectedFiles,
    symbols: [],
    riskGroups,
    suggestedOperationCategories: ['rename', 'inline', 'extract', 'move', 'replace'],
    safeNotes: [
      'preserve formatting — codemods that emit prettier-incompatible output are rejected at review',
      'always run `bun test` after applying the codemod',
      'commit the codemod script alongside the changes for replay',
    ],
    unsafeNotes:
      affectedFiles.length > 50
        ? [`large blast radius: ${affectedFiles.length} files — split the codemod into batches`]
        : [],
    testRecommendations: [
      'bun test',
      'bun x tsc -p tsconfig.base.json --noEmit',
      'shrk check boundaries --changed-only',
    ],
    codemodStarterMetadata: {
      language: 'typescript',
      dialect,
      starterPath: null,
    },
  };

  if (opts.writeStarter) {
    const taskSlug = (opts.task ?? 'task').replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'codemod';
    starterPath = nodePath.join(
      opts.cwd,
      '.sharkcraft',
      'fixes',
      taskSlug,
      'codemod.ts',
    );
    starterBody =
      dialect === 'ts-morph'
        ? tsMorphStarter(plan)
        : dialect === 'jscodeshift'
          ? jscodeshiftStarter(plan)
          : plainStarter(plan);
    mkdirSync(nodePath.dirname(starterPath), { recursive: true });
    writeFileSync(starterPath, starterBody, 'utf8');
    (plan.codemodStarterMetadata as { starterPath: string | null }).starterPath = nodePath.relative(
      opts.cwd,
      starterPath,
    );
  }

  const body = asJson(plan);
  if (opts.output) {
    const abs = nodePath.isAbsolute(opts.output) ? opts.output : nodePath.resolve(opts.cwd, opts.output);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    process.stdout.write(asJson({ wrote: abs, bytes: body.length, starterPath: plan.codemodStarterMetadata.starterPath }) + '\n');
  } else {
    process.stdout.write(body + '\n');
  }
  return 0;
}

/**
 * --via-graph adapter: takes the same input flags as `shrk impact` and
 * routes through `@shrkcrft/impact-engine` for the v3 graph-backed
 * payload. Defers to that engine; emits a clean error when the graph
 * isn't indexed yet.
 */
async function runViaGraph(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json') || flagString(args, 'format') === 'json';
  const positional = args.positional[0];
  const viaGraphRaw = args.flags.get('via-graph');
  const files = flagList(args, 'files');
  const since = flagString(args, 'since');
  const symbol = flagString(args, 'symbol');
  const fileFlag = flagString(args, 'file');
  const limit = flagNumber(args, 'limit') ?? 200;
  const maxDepth = flagNumber(args, 'max-depth') ?? 5;
  const target = positional ?? fileFlag ?? (typeof viaGraphRaw === 'string' ? viaGraphRaw : undefined);

  const inputs = files.length > 0
    ? { kind: 'files' as const, files }
    : symbol
      ? { kind: 'symbol' as const, symbolId: symbol }
      : since
        ? { kind: 'gitref' as const, ref: since }
        : target
          ? { kind: 'files' as const, files: [target] }
          : undefined;
  if (!inputs) {
    process.stderr.write('Usage: shrk impact --via-graph <fileOrQuery> | --symbol <name> | --files a,b | --since <ref>\n');
    return 2;
  }
  const { analyzeGraphImpact, ImpactReportStore, snapshotImpactAnalysis } = await import(
    '@shrkcrft/impact-engine'
  );
  const analysis = analyzeGraphImpact(inputs, { projectRoot: cwd, limit, maxDepth });
  // Persist a compact snapshot for the doctor + dashboard to read.
  // `--no-persist` opts out (useful when scripting against many trees
  // or when stdout is the only sink the caller cares about).
  const noPersist = flagBool(args, 'no-persist');
  if (!noPersist) {
    try {
      const summary =
        inputs.kind === 'files'
          ? inputs.files.slice(0, 3).join(', ') + (inputs.files.length > 3 ? '…' : '')
          : inputs.kind === 'symbol'
            ? `symbol:${inputs.symbolId}`
            : `gitref:${inputs.ref}`;
      new ImpactReportStore(cwd).write(snapshotImpactAnalysis(analysis, summary));
    } catch {
      // best-effort — never fail the command on a persistence error
    }
  }
  if (wantJson) {
    process.stdout.write(asJson(analysis) + '\n');
    return 0;
  }
  process.stdout.write(header(`Impact (graph): ${target ?? symbol ?? files.join(',') ?? since}`));
  process.stdout.write(`  risk: ${analysis.risk}\n`);
  process.stdout.write(`  direct dependents: ${analysis.directDependents.length}\n`);
  process.stdout.write(`  transitive dependents: ${analysis.transitiveDependents.length}\n`);
  process.stdout.write(`  affected symbols: ${analysis.affectedSymbols.length}\n`);
  process.stdout.write(`  caller files: ${analysis.affectedCallerFiles.length}\n`);
  process.stdout.write(`  affected packages: ${analysis.affectedPackages.length}\n`);
  process.stdout.write(`  affected rules: ${analysis.affectedRules.length}\n`);
  process.stdout.write(`  affected templates: ${analysis.affectedTemplates.length}\n`);
  process.stdout.write(`  likely tests: ${analysis.likelyTests.length}\n`);
  process.stdout.write(`  public API touched: ${analysis.publicApiTouched ? 'yes' : 'no'}\n`);
  if (analysis.riskReasons.length > 0) {
    process.stdout.write('\nRisk reasons:\n');
    for (const r of analysis.riskReasons) process.stdout.write(`  • ${r}\n`);
  }
  if (analysis.validationScope.length > 0) {
    process.stdout.write('\nRun before merging:\n');
    for (const c of analysis.validationScope) process.stdout.write(`  $ ${c}\n`);
  }
  for (const d of analysis.diagnostics.slice(0, 5)) process.stdout.write(`! ${d}\n`);
  return 0;
}

/**
 * `shrk impact --deleted`: deleted-symbol orphan check. Reads the
 * working-tree diff's DELETED files (relative to `--since <ref>` or the
 * default branch) and queries the graph for surviving files that still
 * import them or reference a symbol they declared (alias-resolved, incl.
 * barrel re-exports). Any surviving importer is reported with `file:line`
 * and the command exits non-zero; with none it exits 0 with
 * "no orphaned importers". Mirrors `--via-graph`'s flag/JSON style.
 *
 * The graph is queried against the CURRENT index snapshot — a not-yet-
 * reindexed delete still carries its inbound edges, which is exactly what
 * lets the check see the broken importers before they hit the build.
 */
async function runDeletedOrphans(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json') || flagString(args, 'format') === 'json';
  const sinceRef = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const scan = await computeDeletedOrphans(cwd, {
    ...(sinceRef ? { since: sinceRef } : {}),
    ...(staged ? { staged: true } : {}),
  });
  if (!scan.ok) {
    if (wantJson) {
      process.stdout.write(asJson({ ok: false, error: scan.error }) + '\n');
    } else if (scan.reason === 'diff-unavailable') {
      process.stderr.write(`Cannot resolve diff: ${scan.error ?? 'unknown'}\n`);
    } else {
      process.stderr.write(`${scan.error ?? 'orphan check unavailable'}\n`);
    }
    return 2;
  }
  const deleted = scan.deleted;
  if (deleted.length === 0) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.deleted-orphans/v1',
          resolvedDeleted: [],
          unresolvedDeleted: [],
          orphans: [],
          diagnostics: [`no deleted files in diff vs ${scan.ref}`],
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Deleted-symbol orphans'));
    process.stdout.write(`No deleted files in diff vs ${scan.ref}.\n`);
    return 0;
  }

  const report = scan.report!;
  if (wantJson) {
    process.stdout.write(asJson(report) + '\n');
    return report.orphans.length > 0 ? 1 : 0;
  }

  process.stdout.write(header('Deleted-symbol orphans'));
  process.stdout.write(`Deleted files (vs ${scan.ref}): ${deleted.length}\n`);
  if (report.orphans.length === 0) {
    process.stdout.write('no orphaned importers\n');
    for (const d of report.diagnostics.slice(0, 5)) process.stdout.write(`! ${d}\n`);
    return 0;
  }
  process.stdout.write(
    `\n${report.orphans.length} surviving importer(s) still reference deleted code:\n`,
  );
  for (const o of report.orphans) {
    const loc = o.path ? `${o.path}${o.line ? `:${o.line}` : ''}` : o.id;
    const detail =
      o.via === 'reference' && o.symbol
        ? `references \`${o.symbol}\``
        : 'imports';
    process.stdout.write(`  ✗ ${loc} ${detail} from deleted ${o.deletedFile}\n`);
  }
  for (const d of report.diagnostics.slice(0, 5)) process.stdout.write(`! ${d}\n`);
  return 1;
}

export const impactCommand: ICommandHandler = {
  name: 'impact',
  description:
    'Architecture impact analysis: direct + transitive dependents, risk + suggested commands. Supports fuzzy <query> resolution. Read-only.',
  usage:
    'shrk impact <fileOrQuery> | --file <path> | --specifier <spec> | --since <ref> | --staged | --files a,b | --plan <plan.json> | --bundle <id> | --deleted [--since <ref>] [--max-depth N] [--limit N] [--format text|markdown|html|json] [--output <path>] [--tree|--no-tree] [--json] [--html] [--resolve|--resolve-only|--explain-resolution|--no-resolve]',
  async run(args: ParsedArgs): Promise<number> {
    if (args.positional[0] === 'tests') {
      return runImpactTests({ ...args, positional: args.positional.slice(1) });
    }
    if (args.positional[0] === 'graph') {
      return runImpactGraph({ ...args, positional: args.positional.slice(1) });
    }
    if (args.positional[0] === 'baseline') {
      return runImpactBaseline({ ...args, positional: args.positional.slice(1) });
    }
    // --via-graph: route through @shrkcrft/impact-engine for the v3
    // graph-backed payload (sharkcraft.graph-impact-analysis/v3). Keeps
    // the legacy v2 inspector path as the default so existing
    // consumers don't shift.
    if (args.flags.has('via-graph')) {
      return runViaGraph(args);
    }
    // --deleted: reverse-of-impact orphan check. Reads the working-tree
    // diff's DELETED files and asks the graph which surviving files still
    // import them or reference a symbol they declared. Any surviving
    // importer is an error (its build breaks once the delete lands).
    if (args.flags.has('deleted')) {
      return runDeletedOrphans(args);
    }
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    // Warm construct cache so fuzzy resolution can map plugin keys / events /
    // tokens back to construct files. Safe no-op if no constructs are defined.
    try {
      await warmConstructCache(inspection);
    } catch {
      // best-effort
    }
    // Direct symbol impact via --symbol <Name>
    const symbolFlag = flagString(args, 'symbol');
    if (symbolFlag) {
      const language = (flagString(args, 'language') ?? 'auto') as
        | 'auto' | 'typescript' | 'java' | 'csharp' | 'python' | 'go' | 'rust';
      const symReport = findSymbolInProject(cwd, symbolFlag, { language });
      const wantJson = flagBool(args, 'json') || flagString(args, 'format') === 'json';
      const exactCount = symReport.exactMatches.length;
      if (exactCount === 0) {
        if (wantJson) {
          process.stdout.write(asJson(symReport) + '\n');
        } else {
          process.stdout.write(header(`Symbol impact: ${symbolFlag}`));
          process.stdout.write(`  no exact-export or exact-local match found.\n`);
          if (symReport.textMatches.length > 0) {
            process.stdout.write(`  text matches (likely usages): ${symReport.textMatches.length}\n`);
            for (const t of symReport.textMatches.slice(0, 8)) {
              process.stdout.write(`    • ${t.relativePath}\n`);
            }
          }
          process.stdout.write('\nNext commands:\n');
          process.stdout.write(`  shrk trace --symbol ${symbolFlag}\n`);
          process.stdout.write(`  shrk find "${symbolFlag}"\n`);
        }
        return 1;
      }
      if (exactCount > 1) {
        if (wantJson) {
          process.stdout.write(asJson(symReport) + '\n');
        } else {
          process.stdout.write(header(`Symbol impact: ${symbolFlag} (${exactCount} matches)`));
          process.stdout.write('Alternatives:\n');
          for (const m of symReport.exactMatches) {
            process.stdout.write(`  • ${m.relativePath} (${m.resolution}) — ${m.message}\n`);
          }
          process.stdout.write('\nNext commands:\n');
          process.stdout.write(`  shrk impact <file>\n`);
          process.stdout.write(`  shrk trace --symbol ${symbolFlag}\n`);
        }
        return 1;
      }
      // Exactly one — push the file into the impact pipeline.
      const primary = symReport.exactMatches[0]!;
      if (primary.resolution !== 'exact-export') {
        process.stderr.write(
          `[symbol] note: \`${symbolFlag}\` resolves to a non-exported (${primary.resolution}) declaration in ${primary.relativePath}.\n`,
        );
      }
      const collected = {
        files: [primary.relativePath],
        planTargets: [],
        kind: ImpactInputKind.File,
        diagnostics: ['resolved via --symbol'],
      };
      const reportEarly = await analyzeImpact(inspection, {
        files: collected.files,
        planTargets: [],
        ...(typeof flagNumber(args, 'max-depth') === 'number' ? { maxDepth: flagNumber(args, 'max-depth')! } : {}),
        ...(typeof flagNumber(args, 'limit') === 'number' ? { limit: flagNumber(args, 'limit')! } : {}),
      });
      if (wantJson) {
        process.stdout.write(asJson({ symbol: symReport, impact: reportEarly }) + '\n');
        return 0;
      }
      process.stdout.write(header(`Symbol impact: ${symbolFlag}`));
      process.stdout.write(`Resolved: ${primary.relativePath} (${primary.resolution})\n\n`);
      process.stdout.write(renderImpactText(reportEarly));
      return 0;
    }

    const collected = collectFiles(args, cwd);
    const positionalRest = args.positional.slice(1).join(' ').trim();
    const task = flagString(args, 'task') ?? (positionalRest.length > 0 ? positionalRest : undefined);
    const maxDepth = flagNumber(args, 'max-depth');
    const limit = flagNumber(args, 'limit');

    // Fuzzy query resolution.
    const wantJsonEarly = flagBool(args, 'json') || flagString(args, 'format') === 'json';
    const explainResolution = flagBool(args, 'explain-resolution');
    const resolveOnly = flagBool(args, 'resolve-only');
    const forceResolve = flagBool(args, 'resolve');
    const noResolve = flagBool(args, 'no-resolve');

    // A "positional query" is the first positional with no other input source.
    const onlyPositional =
      args.positional.length > 0 &&
      !flagString(args, 'specifier') &&
      !flagString(args, 'file') &&
      flagList(args, 'files').length === 0 &&
      !flagString(args, 'since') &&
      !flagBool(args, 'staged') &&
      !flagString(args, 'plan') &&
      !flagString(args, 'bundle');
    const rawQuery = onlyPositional ? args.positional[0]! : null;
    const positionalResolvesToFile = rawQuery
      ? existsSync(
          nodePath.isAbsolute(rawQuery) ? rawQuery : nodePath.join(cwd, rawQuery),
        )
      : false;
    const looksLikeSpecifier = rawQuery
      ? rawQuery.startsWith('@') || /^[a-z]+:/i.test(rawQuery)
      : false;

    let fuzzyResolution: IFuzzyImpactResolution | undefined;
    const shouldFuzzy =
      rawQuery !== null &&
      !noResolve &&
      (forceResolve || resolveOnly || explainResolution || (!positionalResolvesToFile && !looksLikeSpecifier));

    if (shouldFuzzy && rawQuery) {
      fuzzyResolution = resolveFuzzyImpact(inspection, rawQuery, {
        resolveOnly,
      });
      if (resolveOnly) {
        const payload = {
          schema: fuzzyResolution.schema,
          query: fuzzyResolution.query,
          confidence: fuzzyResolution.confidence,
          source: fuzzyResolution.source,
          resolvedId: fuzzyResolution.resolvedId,
          resolvedLabel: fuzzyResolution.resolvedLabel,
          files: fuzzyResolution.files,
          alternatives: fuzzyResolution.alternatives,
          shouldRunImpact: fuzzyResolution.shouldRunImpact,
          followUpCommands: fuzzyResolution.followUpCommands,
          diagnostics: fuzzyResolution.diagnostics,
        };
        if (wantJsonEarly) {
          process.stdout.write(asJson(payload) + '\n');
        } else {
          process.stdout.write(header(`Impact resolution: ${rawQuery}`));
          process.stdout.write(`Source:     ${fuzzyResolution.source}\n`);
          process.stdout.write(`Confidence: ${fuzzyResolution.confidence}\n`);
          if (fuzzyResolution.resolvedId)
            process.stdout.write(`Resolved:   ${fuzzyResolution.resolvedId}\n`);
          if (fuzzyResolution.files.length > 0) {
            process.stdout.write('Files:\n');
            for (const f of fuzzyResolution.files) process.stdout.write(`  + ${f}\n`);
          }
          if (fuzzyResolution.alternatives.length > 0) {
            process.stdout.write('Alternatives:\n');
            for (const a of fuzzyResolution.alternatives) {
              process.stdout.write(`  • ${a.kind.padEnd(12)} ${a.id} [${a.score.toFixed(0)}]\n`);
            }
          }
          if (fuzzyResolution.followUpCommands.length > 0) {
            process.stdout.write('Follow-up commands:\n');
            for (const c of fuzzyResolution.followUpCommands)
              process.stdout.write(`  $ ${c}\n`);
          }
          for (const d of fuzzyResolution.diagnostics)
            process.stdout.write(`  ! ${d}\n`);
        }
        return fuzzyResolution.resolvedId ? 0 : 1;
      }
      // Splice resolved files into the impact input when high-confidence.
      if (fuzzyResolution.shouldRunImpact && fuzzyResolution.files.length > 0) {
        for (const f of fuzzyResolution.files) collected.files.push(f);
        collected.files = [...new Set(collected.files)];
        collected.kind = ImpactInputKind.File;
      } else if (!fuzzyResolution.shouldRunImpact && !explainResolution) {
        // Ambiguous / low-confidence — surface alternatives + exit without auto-running.
        if (wantJsonEarly) {
          process.stdout.write(asJson(fuzzyResolution) + '\n');
        } else {
          process.stdout.write(header(`Impact: ambiguous query "${rawQuery}"`));
          process.stdout.write(`Confidence: ${fuzzyResolution.confidence}\n`);
          if (fuzzyResolution.resolvedId) {
            process.stdout.write(
              `Best:       ${fuzzyResolution.matchKind ?? '?'} ${fuzzyResolution.resolvedId}\n`,
            );
          }
          if (fuzzyResolution.alternatives.length > 0) {
            process.stdout.write('Alternatives:\n');
            for (const a of fuzzyResolution.alternatives) {
              process.stdout.write(`  • ${a.kind.padEnd(12)} ${a.id} [${a.score.toFixed(0)}]\n`);
            }
          }
          if (fuzzyResolution.followUpCommands.length > 0) {
            process.stdout.write('Try:\n');
            for (const c of fuzzyResolution.followUpCommands)
              process.stdout.write(`  $ ${c}\n`);
          }
          for (const d of fuzzyResolution.diagnostics)
            process.stdout.write(`  ! ${d}\n`);
          process.stdout.write(renderFailureHints(fuzzyImpactAmbiguousHints()));
        }
        return 1;
      }
    }

    const result = await analyzeImpact(inspection, {
      ...(task ? { task } : {}),
      files: collected.files,
      planTargets: collected.planTargets,
      ...(collected.specifier ? { specifier: collected.specifier } : {}),
      inputKind: collected.kind,
      ...(maxDepth ? { maxDepth } : {}),
      ...(limit ? { limit } : {}),
    });

    // Surface the per-call diagnostics on top of the engine's own.
    for (const d of collected.diagnostics) {
      (result.diagnostics as string[]).push(d);
    }

    // `--plan-format codemod|ts-morph|jscodeshift` emits a stable
    // codemod-handoff plan instead of the usual impact render. SharkCraft
    // is not a codemod engine; this plan is meant to be consumed by
    // external codemod tools or by humans hand-writing the migration.
    const planFormat = flagString(args, 'plan-format');
    if (planFormat) {
      return await emitCodemodPlan({
        cwd,
        analysis: result,
        format: planFormat,
        writeStarter: flagBool(args, 'write-starter'),
        task,
        output: flagString(args, 'output'),
      });
    }

    const wantHtml = flagBool(args, 'html');
    const format =
      flagString(args, 'format') ??
      (wantHtml ? 'html' : flagBool(args, 'json') ? 'json' : 'text');
    const treeArg = args.flags.get('tree');
    const treeOption = treeArg === undefined ? undefined : treeArg !== '';
    const noTree = flagBool(args, 'no-tree');
    const useTree = noTree ? false : (treeOption ?? true);
    const renderOpts = { tree: useTree };

    // Polyglot mode — auto (default), off, only.
    const polyglotModeRaw = (flagString(args, 'polyglot-mode') ?? '').toLowerCase();
    const noPolyglot = flagBool(args, 'no-polyglot');
    const polyglotOnly = flagBool(args, 'polyglot-only');
    let polyglotMode: 'auto' | 'off' | 'only' = 'auto';
    if (polyglotModeRaw === 'off' || noPolyglot) polyglotMode = 'off';
    else if (polyglotModeRaw === 'only' || polyglotOnly) polyglotMode = 'only';
    else if (polyglotModeRaw === 'auto' || polyglotModeRaw === '') polyglotMode = 'auto';

    // Build a small polyglot impact block for non-TS files.
    const polyglotBlock = polyglotMode === 'off'
      ? null
      : await buildPolyglotImpactBlock(cwd, collected.files);

    let body: string;
    if (polyglotMode === 'only') {
      if (format === 'json') {
        body = asJson({ polyglot: polyglotBlock, resolution: fuzzyResolution }) + '\n';
      } else if (format === 'markdown') {
        body = polyglotBlock ? renderPolyglotImpactMd(polyglotBlock) : '_(no polyglot impact)_\n';
      } else if (format === 'html') {
        body = polyglotBlock ? '<pre>' + escapeHtml(renderPolyglotImpactText(polyglotBlock)) + '</pre>' : '<p>(no polyglot impact)</p>';
      } else {
        body = polyglotBlock ? renderPolyglotImpactText(polyglotBlock) : '(no polyglot impact)\n';
      }
    } else if (format === 'json') {
      body = asJson({ ...result, polyglot: polyglotBlock, resolution: fuzzyResolution }) + '\n';
    } else if (format === 'markdown') {
      body = renderImpactMarkdown(result, renderOpts) + (polyglotBlock ? '\n' + renderPolyglotImpactMd(polyglotBlock) : '');
      if (fuzzyResolution && explainResolution) body = renderResolutionMd(fuzzyResolution) + '\n\n' + body;
    } else if (format === 'html') {
      body = renderImpactHtml(result, renderOpts) + (polyglotBlock ? '<pre>' + escapeHtml(renderPolyglotImpactText(polyglotBlock)) + '</pre>' : '');
      if (fuzzyResolution && explainResolution) body = '<pre>' + escapeHtml(renderResolutionText(fuzzyResolution)) + '</pre>\n' + body;
    } else {
      body = renderImpactText(result, renderOpts) + (polyglotBlock ? '\n' + renderPolyglotImpactText(polyglotBlock) : '');
      if (fuzzyResolution && (explainResolution || fuzzyResolution.source !== FuzzyImpactSourceKind.ExactFile)) {
        body = renderResolutionText(fuzzyResolution) + '\n' + body;
      }
    }

    const output = flagString(args, 'output');
    if (output) {
      const abs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
      if (format === 'json') process.stdout.write(asJson({ wrote: abs, bytes: body.length }) + '\n');
      else process.stdout.write(`Wrote ${abs}\n`);
    } else {
      process.stdout.write(body);
    }

    // Optional --graph-format / --graph-output side-output.
    const graphFormat = flagString(args, 'graph-format') as ImpactGraphFormat | undefined;
    const graphOutput = flagString(args, 'graph-output');
    if (graphFormat) {
      if (graphFormat !== 'mermaid' && graphFormat !== 'dot') {
        process.stderr.write(`Unknown --graph-format "${graphFormat}". Use mermaid|dot.\n`);
        return 2;
      }
      const graph = renderImpactGraph(result, graphFormat);
      if (graphOutput) {
        const abs = nodePath.isAbsolute(graphOutput) ? graphOutput : nodePath.resolve(cwd, graphOutput);
        mkdirSync(nodePath.dirname(abs), { recursive: true });
        writeFileSync(abs, graph, 'utf8');
        process.stdout.write(`Wrote ${abs}\n`);
        if (flagBool(args, 'render-svg')) {
          const { renderImpactGraphSvg } = await import('@shrkcrft/inspector');
          const svgPath = abs.replace(/\.(mmd|dot)$/, '') + '.svg';
          const result = await renderImpactGraphSvg({
            sourceFile: abs,
            svgFile: svgPath,
            format: graphFormat,
          });
          if (result.rendered) {
            process.stdout.write(`Rendered SVG → ${result.svgFile} (via ${result.renderer})\n`);
          } else {
            process.stdout.write(
              `SVG render skipped: ${result.reason ?? 'unknown'}. Source is at ${abs}.\n`,
            );
          }
        }
      } else {
        process.stdout.write(graph);
      }
    }
    return 0;
  },
};

async function runImpactGraph(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const file = args.positional[0];
  if (!file) {
    process.stderr.write(
      'Usage: shrk impact graph <impact-report.json> [--format mermaid|dot] [--output <path>]\n',
    );
    return 2;
  }
  const abs = nodePath.isAbsolute(file) ? file : nodePath.resolve(cwd, file);
  if (!existsSync(abs)) {
    process.stderr.write(`Impact report not found: ${abs}\n`);
    return 1;
  }
  let impact: IImpactAnalysis;
  try {
    impact = JSON.parse(readFileSync(abs, 'utf8')) as IImpactAnalysis;
  } catch (e) {
    process.stderr.write(`Failed to parse impact report: ${(e as Error).message}\n`);
    return 1;
  }
  const fmt = (flagString(args, 'format') ?? 'mermaid') as ImpactGraphFormat;
  if (fmt !== 'mermaid' && fmt !== 'dot') {
    process.stderr.write(`Unknown --format "${fmt}". Use mermaid|dot.\n`);
    return 2;
  }
  const body = renderImpactGraph(impact, fmt);
  const output = flagString(args, 'output');
  if (output) {
    const outAbs = nodePath.isAbsolute(output) ? output : nodePath.resolve(cwd, output);
    mkdirSync(nodePath.dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, body, 'utf8');
    process.stdout.write(`Wrote ${outAbs}\n`);
    if (flagBool(args, 'render-svg')) {
      const { renderImpactGraphSvg } = await import('@shrkcrft/inspector');
      const svgPath = outAbs.replace(/\.(mmd|dot)$/, '') + '.svg';
      const result = await renderImpactGraphSvg({
        sourceFile: outAbs,
        svgFile: svgPath,
        format: fmt,
      });
      if (result.rendered) {
        process.stdout.write(`Rendered SVG → ${result.svgFile} (via ${result.renderer})\n`);
      } else {
        process.stdout.write(
          `SVG render skipped: ${result.reason ?? 'unknown'}. Source is at ${outAbs}.\n`,
        );
      }
    }
    return 0;
  }
  process.stdout.write(body);
  return 0;
}

async function runImpactTests(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const task = args.positional.join(' ').trim() || undefined;
  const explicitFiles = flagList(args, 'files');
  const since = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const bundleId = flagString(args, 'bundle');
  const files: string[] = [...explicitFiles];
  if (since) files.push(...getChangedFiles(cwd, { since }));
  if (staged) files.push(...getChangedFiles(cwd, { staged: true }));
  if (bundleId) {
    const b = readFeatureBundle(cwd, bundleId);
    if (!b) {
      process.stderr.write(`No bundle "${bundleId}"\n`);
      return 1;
    }
    for (const f of b.affectedFiles) files.push(f);
    for (const p of b.plans) for (const t of p.expectedTargets) files.push(t);
  }
  const uniqueFiles = [...new Set(files)];
  const result = analyzeTestImpact(inspection, {
    ...(task ? { task } : {}),
    files: uniqueFiles,
  });
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(result) + '\n');
    return 0;
  }
  process.stdout.write(header(`Test impact (${uniqueFiles.length} files)`));
  process.stdout.write(`Likely tests: ${result.likelyTestFiles.length}\n`);
  for (const f of result.likelyTestFiles.slice(0, 10)) process.stdout.write(`  + ${f}\n`);
  process.stdout.write(`Missing tests: ${result.missingTestFiles.length}\n`);
  for (const f of result.missingTestFiles.slice(0, 10)) process.stdout.write(`  - ${f}\n`);
  process.stdout.write(`Confidence: ${result.confidence}%\n`);
  process.stdout.write('Minimal commands:\n');
  for (const c of result.minimalCommands) process.stdout.write(`  $ ${c}\n`);
  process.stdout.write('Full commands:\n');
  for (const c of result.fullCommands) process.stdout.write(`  $ ${c}\n`);
  if (result.packageCommands.length > 0) {
    process.stdout.write('Per-package:\n');
    for (const pc of result.packageCommands) {
      process.stdout.write(`  ${pc.packageName}:\n`);
      for (const c of pc.commands) process.stdout.write(`    $ ${c}\n`);
    }
  }
  return 0;
}


interface IPolyglotImpactBlock {
  byLanguage: Readonly<Record<string, {
    files: readonly string[];
    likelyTests: readonly string[];
    verificationCommands: readonly string[];
    boundaryConcerns: readonly { ruleId: string; severity: string; from: string }[];
    externalDeps: readonly string[];
  }>>;
}

const POLYGLOT_EXT_LANG: Readonly<Record<string, string>> = {
  '.java': 'java',
  '.cs': 'csharp',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

async function buildPolyglotImpactBlock(cwd: string, files: readonly string[]): Promise<IPolyglotImpactBlock | null> {
  const polyglotFiles = files.filter((f) => {
    const ext = nodePath.extname(f).toLowerCase();
    return POLYGLOT_EXT_LANG[ext] !== undefined;
  });
  if (polyglotFiles.length === 0) return null;
  const {
    buildLanguageCommandReport,
    buildPolyglotBoundaryReport,
    computePolyglotTestImpact,
    detectLanguageProfiles,
    scanPolyglotDependencies,
    LanguageId,
  } = await import('@shrkcrft/inspector');
  const profile = detectLanguageProfiles(cwd);
  const commandReport = buildLanguageCommandReport(cwd, profile);
  const wantedLangs = new Set<string>();
  for (const f of polyglotFiles) {
    const ext = nodePath.extname(f).toLowerCase();
    const lang = POLYGLOT_EXT_LANG[ext];
    if (lang) wantedLangs.add(lang);
  }
  const langList: string[] = Array.from(wantedLangs);
  const langIds = langList.map((l) => l as unknown as typeof LanguageId.Java);
  const depGraph = scanPolyglotDependencies(cwd, { languages: langIds as never[] });
  const boundary = buildPolyglotBoundaryReport({ projectRoot: cwd, languages: langIds as never[], cached: profile, graph: depGraph });
  const testImpact = computePolyglotTestImpact(cwd, polyglotFiles as string[]);

  const byLanguage: Record<string, {
    files: readonly string[];
    likelyTests: readonly string[];
    verificationCommands: readonly string[];
    boundaryConcerns: readonly { ruleId: string; severity: string; from: string }[];
    externalDeps: readonly string[];
  }> = {};
  for (const lang of langList) {
    const langFiles = polyglotFiles.filter((f) => POLYGLOT_EXT_LANG[nodePath.extname(f).toLowerCase()] === lang);
    const cmds = commandReport.profiles.find((c) => c.language === lang);
    const commands: string[] = [];
    if (cmds) {
      if (cmds.test) commands.push(cmds.test);
      if (cmds.typecheck) commands.push(cmds.typecheck);
      if (cmds.lint) commands.push(cmds.lint);
    }
    const tests = testImpact.impacted
      .filter((i) => i.language === lang)
      .flatMap((i) => i.predictedTests);
    const concerns = boundary.violations
      .filter((v) => v.language === lang && langFiles.includes(v.fromFile))
      .map((v) => ({ ruleId: v.ruleId, severity: v.severity, from: v.fromFile }));
    const externalDeps = depGraph.perLanguage
      .find((p) => p.language === lang)?.externalDeps ?? [];
    byLanguage[lang] = {
      files: langFiles,
      likelyTests: Array.from(new Set(tests)).slice(0, 12),
      verificationCommands: commands,
      boundaryConcerns: concerns,
      externalDeps: externalDeps.slice(0, 12),
    };
  }
  return { byLanguage };
}

function renderPolyglotImpactText(b: IPolyglotImpactBlock): string {
  const out: string[] = [];
  out.push('--- Polyglot impact ---');
  for (const [lang, info] of Object.entries(b.byLanguage)) {
    out.push(`[${lang}]`);
    if (info.files.length) out.push(`  files:        ${info.files.length}`);
    if (info.likelyTests.length) out.push(`  likely tests: ${info.likelyTests.join(', ')}`);
    if (info.verificationCommands.length) {
      out.push(`  verify:`);
      for (const c of info.verificationCommands) out.push(`    $ ${c}`);
    }
    if (info.boundaryConcerns.length) {
      out.push(`  boundary concerns:`);
      for (const c of info.boundaryConcerns.slice(0, 6)) out.push(`    [${c.severity}] ${c.ruleId} on ${c.from}`);
    }
    if (info.externalDeps.length) out.push(`  external deps: ${info.externalDeps.join(', ')}`);
  }
  return out.join('\n');
}

function renderPolyglotImpactMd(b: IPolyglotImpactBlock): string {
  const out: string[] = [];
  out.push('## Polyglot impact');
  for (const [lang, info] of Object.entries(b.byLanguage)) {
    out.push(`### \`${lang}\``);
    if (info.files.length) out.push(`- Files: ${info.files.length}`);
    if (info.likelyTests.length) out.push(`- Likely tests: ${info.likelyTests.map((t) => '`' + t + '`').join(', ')}`);
    if (info.verificationCommands.length) {
      out.push('- Verify:');
      for (const c of info.verificationCommands) out.push(`  - \`${c}\``);
    }
    if (info.boundaryConcerns.length) {
      out.push('- Boundary concerns:');
      for (const c of info.boundaryConcerns) out.push(`  - **${c.severity}** \`${c.ruleId}\` on \`${c.from}\``);
    }
    if (info.externalDeps.length) out.push(`- External deps: ${info.externalDeps.map((d) => '`' + d + '`').join(', ')}`);
  }
  return out.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function renderResolutionText(r: IFuzzyImpactResolution): string {
  const out: string[] = [];
  out.push(`=== Fuzzy impact resolution ===`);
  out.push(`Query:      ${r.query}`);
  out.push(`Source:     ${r.source}`);
  out.push(`Confidence: ${r.confidence}`);
  if (r.resolvedId) out.push(`Resolved:   ${r.matchKind ?? ''} ${r.resolvedId}`);
  if (r.files.length > 0) {
    out.push(`Files:`);
    for (const f of r.files) out.push(`  + ${f}`);
  }
  if (r.alternatives.length > 0) {
    out.push(`Alternatives:`);
    for (const a of r.alternatives.slice(0, 5))
      out.push(`  • ${a.kind.padEnd(12)} ${a.id} [${a.score.toFixed(0)}]`);
  }
  if (r.followUpCommands.length > 0) {
    out.push(`Follow-up:`);
    for (const c of r.followUpCommands) out.push(`  $ ${c}`);
  }
  for (const d of r.diagnostics) out.push(`  ! ${d}`);
  return out.join('\n') + '\n';
}

function renderResolutionMd(r: IFuzzyImpactResolution): string {
  const out: string[] = [];
  out.push(`## Fuzzy impact resolution`);
  out.push(`- Query: \`${r.query}\``);
  out.push(`- Source: \`${r.source}\``);
  out.push(`- Confidence: \`${r.confidence}\``);
  if (r.resolvedId) out.push(`- Resolved: \`${r.matchKind ?? ''}\` \`${r.resolvedId}\``);
  if (r.files.length > 0) {
    out.push(`- Files:`);
    for (const f of r.files) out.push(`  - \`${f}\``);
  }
  if (r.alternatives.length > 0) {
    out.push(`- Alternatives:`);
    for (const a of r.alternatives.slice(0, 5))
      out.push(`  - \`${a.kind}\` \`${a.id}\` (${a.score.toFixed(0)})`);
  }
  if (r.followUpCommands.length > 0) {
    out.push(`- Follow-up commands:`);
    for (const c of r.followUpCommands) out.push(`  - \`${c}\``);
  }
  if (r.diagnostics.length > 0) {
    out.push(`- Diagnostics:`);
    for (const d of r.diagnostics) out.push(`  - ${d}`);
  }
  return out.join('\n');
}

// Sentinel — keep `QueryMatchKind` import alive for tooling. Used inside fuzzy-impact.ts.
void QueryMatchKind;

async function runImpactBaseline(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const verb = args.positional[0] ?? 'show';
  const { ImpactReportStore, diffImpactReports } = await import('@shrkcrft/impact-engine');
  const store = new ImpactReportStore(cwd);

  if (verb === 'write') {
    const last = store.read();
    if (!last) {
      const msg = `No recent impact run at ${store.absPath}. Run \`shrk impact --via-graph <target>\` first.\n`;
      if (wantJson) {
        process.stdout.write(asJson({ ok: false, error: 'no-last-run' }) + '\n');
        return 1;
      }
      process.stderr.write(msg);
      return 1;
    }
    store.writeBaseline(last);
    if (wantJson) {
      process.stdout.write(asJson({ wrote: store.baselinePath, baseline: last }) + '\n');
      return 0;
    }
    process.stdout.write(`Impact baseline written → ${store.baselinePath}\n`);
    process.stdout.write(
      `  Input: ${last.inputSummary}\n` +
        `  Risk:  ${last.risk}\n` +
        `  Dependents: ${last.directDependentCount} direct, ${last.transitiveDependentCount} transitive\n` +
        `  Packages:   ${last.affectedPackageCount}\n`,
    );
    return 0;
  }
  if (verb === 'show') {
    const baseline = store.readBaseline();
    if (!baseline) {
      const msg = `No baseline at ${store.baselinePath}. Run \`shrk impact baseline write\` to freeze the current run.\n`;
      if (wantJson) {
        process.stdout.write(asJson({ baseline: null, path: store.baselinePath }) + '\n');
        return 1;
      }
      process.stderr.write(msg);
      return 1;
    }
    const last = store.read();
    if (wantJson) {
      process.stdout.write(
        asJson({
          path: store.baselinePath,
          baseline,
          ...(last ? { last, delta: diffImpactReports(baseline, last) } : {}),
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Impact baseline'));
    process.stdout.write(kv('path', store.baselinePath) + '\n');
    process.stdout.write(kv('input', baseline.inputSummary) + '\n');
    process.stdout.write(kv('risk', baseline.risk) + '\n');
    process.stdout.write(
      kv(
        'dependents',
        `${baseline.directDependentCount} direct, ${baseline.transitiveDependentCount} transitive`,
      ) + '\n',
    );
    process.stdout.write(kv('packages', String(baseline.affectedPackageCount)) + '\n');
    if (last) {
      const d = diffImpactReports(baseline, last);
      process.stdout.write(
        '\nDelta (last − baseline): ' +
          `dependents ${d.dependentDelta >= 0 ? '+' : ''}${d.dependentDelta}, ` +
          `packages ${d.packageDelta >= 0 ? '+' : ''}${d.packageDelta}` +
          (d.riskDrift ? `, risk ${d.riskDrift}` : '') +
          (d.worsened ? '  ✗ worsened' : '  ✓ within baseline') +
          '\n',
      );
    } else {
      process.stdout.write('\n(no recent `last.json` — run `shrk impact --via-graph` to populate it.)\n');
    }
    return 0;
  }
  if (verb === 'clear') {
    const removed = store.clearBaseline();
    if (wantJson) {
      process.stdout.write(asJson({ removed, path: store.baselinePath }) + '\n');
      return 0;
    }
    process.stdout.write(
      removed ? `Baseline removed: ${store.baselinePath}\n` : 'No baseline to remove.\n',
    );
    return 0;
  }
  process.stderr.write('Usage: shrk impact baseline <write|show|clear> [--json]\n');
  return 2;
}
