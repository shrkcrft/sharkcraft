import {
  boundaryLoadIssueCoverage,
  boundaryLoadIssueLabel,
  boundaryLoadIssuesFromFile,
  buildAiReadinessReport,
  boundaryRulesCheckedNothing,
  boundaryRulesAcceptedEmpty,
  boundaryRulesEvaluated,
  boundarySkippedRuleRows,
  buildImportHygieneReport,
  buildPackDoctorReportAsync,
  buildPolyglotBoundaryReport,
  importHygieneCoverage,
  packDoctorCoverage,
  packDoctorVerdict,
  diagnoseActionHints,
  diffBoundaryRuleSets,
  emitImportHygieneAllowlistDraft,
  filterViolationsToChangedScope,
  ImportHygieneFindingKind,
  inspectSharkcraft,
  isTodoReason,
  renderImportHygieneText,
  resolveChangedFiles,
  resolveProjectConfig,
  runBoundaryCheck,
  doctorVerdict,
  DoctorVerdictKind,
  runDoctor,
  suggestBoundaryFixes,
  type IBoundaryCheckResult,
  type IBoundaryLoadIssue,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  firstUnknownFlag,
  flagBool,
  flagNumber,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { GLOBAL_FLAGS, IMPLICIT_FLAGS } from '../dispatch/global-flags.ts';
import { unknownFlagRefusal } from '../dispatch/unknown-flag-refusal.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { ExitCode } from '../exit-codes.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';
import { computeDeletedOrphans } from '../diff/deleted-orphans.ts';
import { deletedOrphanCoverage } from '../diff/deleted-orphan-coverage.ts';
import { deletedOrphanScopeNotes } from '../diff/deleted-orphan-scope-notes.ts';
import { renderWiringExplain, settleWiringExplain } from './wiring.command.ts';
import { runRegistryLifecycle } from './registry-lifecycle-run.ts';
import { validateTemplateVariables } from '@shrkcrft/templates';
import { FileChangeType, planGeneration } from '@shrkcrft/generator';
import {
  explainWiring,
  loadBoundaryRulesFromFile,
  runWiring,
  summarizeImports,
  type IBoundaryRule,
  planWiringFix,
  planeScanExcludeDirs,
  readMatchingFiles,
  wiringGlobsOf,
  type IWiringFixEdit,
  type IWiringFixSkip,
  type IWiringReport,
} from '@shrkcrft/boundaries';
import {
  coverageShortfall,
  formatCoverage,
  UnitLivenessState,
  type IVerdictCoverage,
  type IWiringRule,
} from '@shrkcrft/core';
import {
  buildGateEnvelope,
  type IGateEnvelope,
  type IGateRuleResult,
} from '../gates/gate-envelope.ts';
import { ALLOW_EMPTY_FLAG, allowEmptyValve } from '../gates/allow-empty.ts';
import { emptyRuleAdviceLines } from '../gates/empty-rule-advice-lines.ts';
import { qualifyCleanForUnits } from '../gates/qualify-clean-for-units.ts';
import { unitStateNotes } from '../gates/unit-state-notes.ts';
import { templateRegistryCoverage } from '../gates/template-registry-coverage.ts';
import { verdictLine } from '../gates/verdict-line.ts';
import { acceptedEmptyNote } from '../gates/accepted-empty-note.ts';
import { settleVerdict } from '../gates/settle-verdict.ts';
import { planeVerdictForExit } from '../gates/plane-verdict.ts';
import { seamRejectedRules } from '../gates/seam-rejected-rules.ts';

interface IGroupResult {
  name: string;
  passed: boolean;
  errors: number;
  warnings: number;
  details?: string[];
  /** What the group was asked to verify (the doctor's coverage), settled with core's rule. */
  coverage?: readonly IVerdictCoverage[];
  /** True when the group has no error but did not verify its whole scope. */
  notVerified?: boolean;
  /**
   * True when the group had NOTHING to validate (zero knowledge entries,
   * templates, pipelines or packs). Rendered `SKIP`, never `OK`: a zero error
   * count over zero subjects is not a pass. `shrk quality`'s aggregate rule: a
   * deliberate skip by default, NOT VERIFIED (2) under `--strict`.
   */
  examinedNothing?: boolean;
  /**
   * What the group was ASKED to examine, as the coverage its own doctor settles
   * on (`packs doctor` → `packDoctorCoverage`, `templates doctor` →
   * `templateRegistryCoverage`). Settled when the group is requested ALONE
   * (`check packs`): a request for one group that covered zero units is NOT
   * VERIFIED (2) unless `--allow-empty` accepts it — the doctor's answer, never
   * a second one. Bare `check` keeps the SKIP rule above.
   */
  requestCoverage?: readonly IVerdictCoverage[];
  /** The group's settled word, for `--json` readers. */
  status?: 'passed' | 'failed' | 'partial' | 'skipped';
}

function knowledgeGroup(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  args: ParsedArgs,
): IGroupResult {
  const dup = inspection.validationIssues.filter((i) => i.code === 'duplicate-id');
  const missing = inspection.validationIssues.filter((i) => i.code !== 'duplicate-id');
  const loaded = inspection.knowledgeEntries.length;
  return {
    name: 'knowledge',
    passed: missing.length === 0 && dup.length === 0,
    errors: missing.length,
    warnings: dup.length,
    ...(loaded === 0 && missing.length === 0 ? { examinedNothing: true } : {}),
    requestCoverage: [
      {
        unit: 'knowledge entries',
        expected: loaded,
        examined: loaded,
        root: inspection.projectRoot,
        reason: 'no knowledge entry is loaded',
        ...allowEmptyValve(args, loaded),
      },
    ],
    details: [
      ...missing.map((m) => `error: ${m.code} on ${m.entryId}`),
      ...dup.map((m) => `warn: duplicate id ${m.entryId}`),
    ],
  };
}

function templatesGroup(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  args: ParsedArgs,
): IGroupResult {
  const details: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const t of inspection.templates) {
    if (!t.id) {
      errors += 1;
      details.push(`error: template missing id`);
    }
    if (!t.description || t.description.trim().length < 5) {
      warnings += 1;
      details.push(`warn: template ${t.id} description short/missing`);
    }
    if (!t.files && !t.changes && !(t.targetPath && t.content)) {
      errors += 1;
      details.push(
        `error: template ${t.id} missing files, changes, or targetPath+content`,
      );
    }
  }
  return {
    name: 'templates',
    passed: errors === 0,
    errors,
    warnings,
    ...(inspection.templates.length === 0 ? { examinedNothing: true } : {}),
    // THE record `templates doctor` settles on (zero registered → 2).
    requestCoverage: [
      templateRegistryCoverage({
        total: inspection.templates.length,
        root: inspection.projectRoot,
        acceptance: allowEmptyValve(args, inspection.templates.length),
      }),
    ],
    details,
  };
}

function pipelinesGroup(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  args: ParsedArgs,
): IGroupResult {
  const details: string[] = [];
  let errors = 0;
  let warnings = 0;
  for (const p of inspection.pipelines) {
    if (!p.steps || p.steps.length === 0) {
      errors += 1;
      details.push(`error: pipeline ${p.id} has no steps`);
    }
    const stepIds = new Set<string>();
    for (const step of p.steps ?? []) {
      if (stepIds.has(step.id)) {
        errors += 1;
        details.push(`error: pipeline ${p.id} duplicate step ${step.id}`);
      }
      stepIds.add(step.id);
    }
    if (!p.description) {
      warnings += 1;
      details.push(`warn: pipeline ${p.id} has no description`);
    }
  }
  const registered = inspection.pipelines.length;
  return {
    name: 'pipelines',
    passed: errors === 0,
    errors,
    warnings,
    ...(registered === 0 ? { examinedNothing: true } : {}),
    requestCoverage: [
      {
        unit: 'pipelines',
        expected: registered,
        examined: registered,
        root: inspection.projectRoot,
        reason: 'no pipeline is registered',
        ...allowEmptyValve(args, registered),
      },
    ],
    details,
  };
}

async function packsGroup(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  args: ParsedArgs,
): Promise<IGroupResult> {
  // THE async doctor `packs doctor` runs — the registry loaders' rejected
  // entries included. The sync builder never saw them, so `check packs` read
  // `OK packs errors=0` where `packs doctor` exited 1 (round 12 review, R12-X2).
  const report = await buildPackDoctorReportAsync(inspection);
  // THE pack-doctor settlement (`packDoctorVerdict`, the one `shrk packs
  // doctor` exits on): zero packs examined nothing (SKIP, never OK), and a
  // compiled build never compared to its source is a real shortfall.
  const verdict = packDoctorVerdict(report, inspection);
  const compiled = report.compiledArtifactCoverage;
  const compiledShortfall = compiled ? coverageShortfall(compiled) : undefined;
  return {
    name: 'packs',
    passed: report.passed,
    errors: report.summary.errors,
    warnings: report.summary.warnings,
    ...(verdict.examinedNothing ? { examinedNothing: true } : {}),
    ...(compiled && compiledShortfall !== undefined ? { coverage: [compiled], notVerified: true } : {}),
    // THE pack-doctor coverage — what `packs doctor` settles on, valve included
    // (zero discovered packs → 2 when `check packs` is asked alone).
    requestCoverage: packDoctorCoverage(
      report,
      inspection,
      allowEmptyValve(args, inspection.packs.discoveredPacks.length),
    ),
    details: [
      ...report.issues.map((i) => `${i.severity}: ${i.packageName} ${i.code} — ${i.message}`),
      ...(compiledShortfall !== undefined ? [`not verified: ${compiledShortfall}`] : []),
    ],
  };
}

function actionHintsGroup(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
): IGroupResult {
  const report = diagnoseActionHints(inspection.knowledgeEntries);
  return {
    name: 'action-hints',
    passed: true, // warnings only — they do not fail unless --strict
    errors: 0,
    warnings: report.issues.length,
    // Action hints live on knowledge entries: none declared, nothing to lint.
    ...(inspection.knowledgeEntries.length === 0 ? { examinedNothing: true } : {}),
    details: report.issues.map((i) => `warn: ${i.code} on ${i.entryId}`),
  };
}

function doctorGroup(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
): IGroupResult {
  const result = runDoctor(inspection);
  // THE doctor settlement (`doctorVerdict`), the reading `shrk doctor`
  // settles its exit on: a setup it could not fully verify (a compiled pack
  // build with no build record) is NOT VERIFIED here too, never OK.
  const settled = doctorVerdict(result);
  return {
    name: 'doctor',
    passed: result.passed,
    errors: result.summary.errors,
    warnings: result.summary.warnings,
    ...(result.coverage && result.coverage.length > 0 ? { coverage: result.coverage } : {}),
    ...(settled.verdict === DoctorVerdictKind.NotVerified ? { notVerified: true } : {}),
    details: result.checks
      .filter((c) => c.severity === 'error' || c.severity === 'warning')
      .map((c) => `${c.severity}: ${c.title} — ${c.message}`),
  };
}

/**
 * `alone` — the invocation asked for exactly one group (`check packs`). Its
 * request coverage is then the verdict's scope: the group's doctor record, so
 * `check packs` over zero packs is 2 like `packs doctor` (`--allow-empty` → 0).
 */
function renderReport(
  args: ParsedArgs,
  groups: IGroupResult[],
  readinessLine: string | null,
  alone = false,
): number {
  const totalErrors = groups.reduce((s, g) => s + g.errors, 0);
  const totalWarnings = groups.reduce((s, g) => s + g.warnings, 0);
  const passed = totalErrors === 0;
  const strict = flagBool(args, 'strict');
  const minScore = flagNumber(args, 'min-score');
  // Settle first, render second: a group that could not verify part of its
  // scope (the doctor over an unrecorded compiled pack build) turns a clean
  // proposed 0 into NOT VERIFIED (2), in text AND JSON. A group with NOTHING
  // to validate is `shrk quality`'s aggregate rule: a deliberate skip by
  // default (SKIP, never OK), required — so NOT VERIFIED — under `--strict`.
  const emptyGroups = groups.filter((g) => g.examinedNothing === true);
  const emptyUnit: Readonly<Record<string, string>> = {
    knowledge: 'knowledge entries',
    'action-hints': 'knowledge entries (action hints)',
  };
  const settled = settleVerdict(
    passed && (!strict || totalWarnings === 0) ? 0 : 1,
    alone
      ? groups.flatMap((g) => g.requestCoverage ?? g.coverage ?? [])
      : [
          ...groups.flatMap((g) => g.coverage ?? []),
          ...(strict
            ? emptyGroups.map(
                (g): IVerdictCoverage => ({
                  unit: emptyUnit[g.name] ?? g.name,
                  expected: 0,
                  examined: 0,
                  subject: g.name,
                  reason: 'none declared — nothing to validate (required under --strict)',
                }),
              )
            : []),
        ],
  );
  const statusOf = (g: IGroupResult): NonNullable<IGroupResult['status']> =>
    !g.passed ? 'failed' : g.examinedNothing ? 'skipped' : g.notVerified ? 'partial' : 'passed';
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        passed,
        groups: groups.map((g) => ({ ...g, status: statusOf(g) })),
        totals: { errors: totalErrors, warnings: totalWarnings },
        readinessLine,
        exitCode: settled.exit,
        verdict: settled.verdict,
        ...(settled.shortfalls.length > 0 ? { shortfalls: settled.shortfalls } : {}),
        ...(settled.accepted.length > 0 ? { accepted: settled.accepted } : {}),
      }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(header('Check summary'));
  const glyph: Record<NonNullable<IGroupResult['status']>, string> = {
    failed: 'FAIL ',
    skipped: 'SKIP ',
    partial: 'PART ',
    passed: 'OK   ',
  };
  for (const g of groups) {
    const status = statusOf(g);
    process.stdout.write(
      `  ${glyph[status]} ${g.name.padEnd(16)} errors=${g.errors} warnings=${g.warnings}${status === 'skipped' ? ' (examined nothing)' : ''}\n`,
    );
  }
  process.stdout.write(
    `\nTotals: ${totalErrors} errors, ${totalWarnings} warnings\n`,
  );
  if (readinessLine) process.stdout.write(`\n${readinessLine}\n`);
  if (!passed) {
    process.stdout.write('\nDetails (errors):\n');
    for (const g of groups) {
      for (const d of g.details ?? []) if (d.startsWith('error:')) process.stdout.write(`  • ${d}\n`);
    }
  }
  if (strict && totalWarnings > 0) {
    process.stdout.write('\nstrict mode: warnings cause non-zero exit.\n');
  }
  const minOk = minScore === undefined ? true : true; // readiness floor already enforced by shrk doctor; only echo here
  void minOk;
  const line = verdictLine(settled, '');
  if (line) process.stdout.write(`\n${line}\n`);
  if (alone && settled.exit === ExitCode.NotVerified && groups.some((g) => g.examinedNothing === true)) {
    process.stdout.write(`Pass --${ALLOW_EMPTY_FLAG} to accept an empty ${groups[0]?.name ?? 'group'} set explicitly.\n`);
  }
  return settled.exit;
}

// ────────────────────────────────────────────────────────────────────────
// Subcommand: imports
// ────────────────────────────────────────────────────────────────────────
async function checkImports(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const changedOnly = flagBool(args, 'changed-only');
  const since = flagString(args, 'since');
  const scoped = changedOnly || since !== undefined;
  let files: readonly string[] | undefined;
  if (scoped) {
    const changed = resolveChangedFiles({
      projectRoot: cwd,
      ...(since ? { since } : {}),
      ...(changedOnly && !since ? { includeWorktree: true } : {}),
    });
    files = changed.files;
  }
  // Strict mode rejects allowlist entries with TODO/empty reasons.
  const failOnUnexplained = flagBool(args, 'fail-on-unexplained-allowlist');
  const reportOptions: { files?: readonly string[]; strictAllowlistReasons?: boolean } = {};
  if (files) reportOptions.files = files;
  if (failOnUnexplained) reportOptions.strictAllowlistReasons = true;
  const report = buildImportHygieneReport(cwd, reportOptions);

  // `--emit-allowlist <file>` writes a draft JSON allowlist for
  // human review. Each draft entry has a TODO reason placeholder.
  const emitTarget = flagString(args, 'emit-allowlist');
  const onlyCandidates = flagBool(args, 'only-allowlist-candidates');
  if (emitTarget || onlyCandidates) {
    const kindRaw = flagString(args, 'emit-allowlist-kind');
    const kind: ImportHygieneFindingKind | 'all' =
      kindRaw === 'all'
        ? 'all'
        : kindRaw === 'dynamic-import'
          ? ImportHygieneFindingKind.DynamicImport
          : kindRaw === 'runtime-require'
            ? ImportHygieneFindingKind.RuntimeRequire
            : kindRaw === 'inline-type-import'
              ? ImportHygieneFindingKind.InlineTypeImport
              : ImportHygieneFindingKind.DynamicImport;
    const draft = emitImportHygieneAllowlistDraft(report, { kind });
    if (emitTarget) {
      const abs = nodePath.isAbsolute(emitTarget)
        ? emitTarget
        : nodePath.resolve(cwd, emitTarget);
      mkdirSync(nodePath.dirname(abs), { recursive: true });
      writeFileSync(abs, JSON.stringify(draft, null, 2) + '\n', 'utf8');
      if (!flagBool(args, 'json')) {
        process.stdout.write(
          `Wrote draft allowlist with ${draft.allow.length} entry/entries → ${nodePath.relative(cwd, abs)}\n`,
        );
        process.stdout.write(
          `Edit each entry's "reason" to replace the TODO placeholder before strict mode will accept it.\n`,
        );
      }
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson({ draft, report }) + '\n');
      return 0;
    }
    if (onlyCandidates && !emitTarget) {
      process.stdout.write(asJson(draft) + '\n');
    }
    return 0;
  }

  // Settle first, render second. The subject list is THE authority
  // (`importHygieneSubjects`, which `buildImportHygieneReport` scanned): an
  // EMPTY changeset — or one with no .ts/.tsx source — examined nothing, and an
  // unreadable in-scope file was never checked. Either is NOT VERIFIED (2),
  // never "OK"; `--allow-empty` accepts an empty scope explicitly.
  const coverage: IVerdictCoverage = {
    ...importHygieneCoverage(report),
    ...((report.filesInScope ?? 0) === 0
      ? {
          reason: scoped
            ? `no changed .ts/.tsx source in the changeset (${files?.length ?? 0} changed file(s))`
            : 'no .ts/.tsx source under the scanned roots',
        }
      : {}),
    root: cwd,
    ...allowEmptyValve(args, report.filesInScope ?? 0),
  };
  const settled = settleVerdict(report.verdict === 'errors' ? 1 : 0, [coverage]);
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        ...report,
        // The engine word, except when the run settled NOT VERIFIED.
        verdict: settled.exit === ExitCode.NotVerified ? 'not-verified' : report.verdict,
        coverage,
        exitCode: settled.exit,
        shortfalls: settled.shortfalls,
        accepted: settled.accepted,
      }) + '\n',
    );
    return settled.exit;
  }
  process.stdout.write(
    renderImportHygieneText(report, settled.exit === ExitCode.NotVerified ? 'NOT VERIFIED' : undefined),
  );
  // When --fail-on-unexplained-allowlist is set, warn on existing
  // entries whose reason is still TODO/empty. The scanner has already
  // un-suppressed them, but we also surface a separate accounting line.
  if (failOnUnexplained) {
    const allowlistPath = nodePath.join(cwd, 'sharkcraft', 'import-hygiene.allowlist.json');
    if (existsSync(allowlistPath)) {
      try {
        const raw = JSON.parse(readFileSync(allowlistPath, 'utf8')) as {
          allow?: ReadonlyArray<{ path: string; reason?: string; kind?: string }>;
        };
        const unexplained = (raw.allow ?? []).filter((e) => isTodoReason(e.reason));
        if (unexplained.length > 0) {
          process.stdout.write(
            `\nUnexplained allowlist entries (${unexplained.length}):\n`,
          );
          for (const e of unexplained) {
            process.stdout.write(`  • ${e.path}${e.kind ? ` [${e.kind}]` : ''} — reason: ${e.reason ?? '(empty)'}\n`);
          }
          process.stdout.write(
            'Strict mode failing — replace the TODO reason with a real justification or remove the entry.\n',
          );
          return 1;
        }
      } catch {
        // ignore parse errors here; the regular scanner has already surfaced them.
      }
    }
  }
  const line = verdictLine(settled, '');
  if (line) process.stdout.write(`\n${line}\n`);
  if (settled.exit === ExitCode.NotVerified && (report.filesInScope ?? 0) === 0) {
    process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty changeset explicitly.\n`);
  }
  return settled.exit;
}

// ────────────────────────────────────────────────────────────────────────
// Subcommand: generation
// ────────────────────────────────────────────────────────────────────────
async function checkGeneration(args: ParsedArgs): Promise<number> {
  const templateId = args.positional[1];
  const name = args.positional[2];
  if (!templateId || !name) {
    process.stderr.write('Usage: shrk check generation <templateId> <name> [--var k=v ...]\n');
    return 2;
  }
  const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
  const template = inspection.templateRegistry.get(templateId);
  if (!template) {
    process.stderr.write(`No template with id "${templateId}".\n`);
    return 1;
  }
  const vars = flagVars(args);
  const validation = validateTemplateVariables(template.variables, { ...vars, name });
  if (!validation.valid) {
    process.stderr.write('Variable validation failed:\n');
    for (const i of validation.issues) process.stderr.write(`  • ${i.variable}: ${i.message}\n`);
    return 1;
  }
  const result = planGeneration(template, {
    templateId,
    projectRoot: inspection.projectRoot,
    name,
    variables: validation.resolved,
  });
  const plan = result.plan;
  const conflicts = plan.changes.filter((c) => c.type === FileChangeType.Conflict);
  const safe = result.safe;
  if (flagBool(args, 'json')) {
    process.stdout.write(asJson({ templateId, name, safe, conflicts, plan }) + '\n');
    return safe ? 0 : 1;
  }
  process.stdout.write(header(`Check generation: ${templateId} ${name}`));
  process.stdout.write(kv('safe', safe ? 'yes' : 'no') + '\n');
  process.stdout.write(kv('conflicts', String(conflicts.length)) + '\n\n');
  for (const c of plan.changes) {
    process.stdout.write(`  ${c.type.padEnd(8)} ${c.relativePath} (${c.reason ?? ''})\n`);
  }
  return safe ? 0 : 1;
}

// ────────────────────────────────────────────────────────────────────────
// Subcommand: boundaries
// ────────────────────────────────────────────────────────────────────────
function readChangedScopeOptions(args: ParsedArgs, cwd: string): IChangedScopeOptions | null {
  const changedOnly = flagBool(args, 'changed-only');
  const staged = flagBool(args, 'staged');
  const since = flagString(args, 'since');
  const filesRaw = flagString(args, 'files');
  const files = filesRaw
    ? filesRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [];
  if (!changedOnly && !staged && !since && files.length === 0) return null;
  const out: IChangedScopeOptions = { projectRoot: cwd };
  if (files.length > 0) out.files = files;
  else if (staged) out.staged = true;
  else if (since) out.since = since;
  else out.includeWorktree = true;
  return out;
}

/**
 * Flags `check boundaries` accepts. Anything else is a typo, never an opt-in:
 * `--rules` / `--diff-agains` used to parse as a silent `true` and the verb ran
 * its bare form at exit 0 (round 11, 3.3#2 / 5.2).
 */
const BOUNDARY_CHECK_FLAGS: ReadonlySet<string> = new Set([
  'rule',
  'rule-file',
  'diff-against',
  'include-comments',
  'fail-on-dead-units',
  'no-rule-escalation',
  'changed-only',
  'since',
  'staged',
  'files',
  'polyglot',
  'strict',
  'json',
  'fix-suggestions',
  'watch',
  'paths',
  'debounce',
  'once',
  ALLOW_EMPTY_FLAG,
  // Every dispatcher global (THE list) — a direct handler call may carry them.
  ...GLOBAL_FLAGS,
]);

const BOUNDARIES_CHECK_USAGE =
  'shrk check boundaries [--rule <id>] [--rule-file <path> | --diff-against <path>]\n' +
  '                      [--changed-only | --since <ref> | --staged | --files a,b] [--no-rule-escalation]\n' +
  '                      [--include-comments] [--fail-on-dead-units] [--allow-empty] [--strict]\n' +
  '                      [--fix-suggestions] [--polyglot] [--json] [--watch [--paths a,b] [--debounce N] [--once]]\n' +
  '  Evaluate every boundary rule against the import graph (tsconfig aliases resolved).\n' +
  '    --rule <id>            evaluate one rule (an unknown id is a usage error)\n' +
  '    --rule-file <path>     evaluate ONLY the rules in a candidate file (the boundaryFiles loader)\n' +
  '    --diff-against <path>  dry run: violations a candidate rule set would ADD / REMOVE vs the active set\n' +
  '                           (--strict does not apply to the diff: it settles on error violations, dead\n' +
  '                           candidate scopes and --fail-on-dead-units only; a warning it adds is reported)\n' +
  '    --changed-only …       report violations the changeset introduced; a changeset touching a rule\n' +
  '                           source, the config or tsconfig ESCALATES those rules to the whole tree\n' +
  '    --no-rule-escalation   keep escalated rules out — they are then reported unexamined (exit 2)\n' +
  '    --include-comments     read imports from raw text (a commented-out import counts again)\n' +
  '    --fail-on-dead-units   a selector unit that matches nothing, or a local expectEmpty marker whose\n' +
  '                           target appeared (went live), fails the run (1); a pack marker never does\n' +
  '    --strict               warning violations fail too, and so does a local went-live expectEmpty marker\n' +
  '  A unit marked { pattern, expectEmpty: true } whose target does not exist yet is accepted (printed).\n' +
  '  Exit: 0 verified pass · 1 violations / errored rule / stale exception / failOnEmpty rule\n' +
  '        2 not verified (a rule checked nothing, an empty selection, a suppressed escalation) · 3 usage';

async function checkBoundaries(args: ParsedArgs): Promise<number> {
  // `--help` / `-h` never reaches here: the dispatcher answers it (dispatch/help-intercept.ts).
  const bad = firstUnknownFlag(args, BOUNDARY_CHECK_FLAGS);
  if (bad !== undefined) {
    // THE one refusal format (round 13, lane P) — the dispatcher's own wording.
    const shown = [...BOUNDARY_CHECK_FLAGS].filter((f) => !IMPLICIT_FLAGS.has(f));
    const refusal = unknownFlagRefusal({
      label: 'check boundaries',
      flags: [bad],
      known: shown,
      accepts: shown,
      ...(args.argv !== undefined ? { argv: args.argv } : {}),
      exitCode: ExitCode.UsageError,
    });
    process.stderr.write(refusal.message);
    return refusal.exitCode;
  }
  for (const flag of ['rule', 'rule-file', 'diff-against']) {
    if (args.flags.has(flag) && !flagString(args, flag)) {
      process.stderr.write(`--${flag} needs a value.\n${BOUNDARIES_CHECK_USAGE}\n`);
      return ExitCode.UsageError;
    }
  }
  if (args.flags.has('rule-file') && args.flags.has('diff-against')) {
    process.stderr.write(
      '--rule-file and --diff-against are exclusive: --rule-file evaluates a candidate alone, --diff-against compares it with the active rules.\n',
    );
    return ExitCode.UsageError;
  }
  const watchExit = await maybeRunInWatchMode(args, checkBoundariesOnce, {
    defaultPaths: BOUNDARIES_DEFAULT_WATCH_PATHS,
  });
  if (watchExit !== null) return watchExit;
  return checkBoundariesOnce(args);
}

const BOUNDARIES_DEFAULT_WATCH_PATHS: readonly string[] = [
  'sharkcraft',
  'packages',
  'apps',
  'libs',
  'src',
  'tools',
];

/**
 * Load a `--rule-file` / `--diff-against` candidate through THE boundary rule
 * loader (the one `boundaryFiles` use — it transpiles TS on the fly, so a rule
 * edit is testable without a build). A missing file, one that throws, or one
 * with no valid rule is a usage error; invalid rules next to valid ones become
 * errored-rule rows.
 */
async function loadBoundaryRuleFileArg(
  cwd: string,
  projectRoot: string,
  raw: string,
  flag: string,
): Promise<
  | { ok: true; path: string; rules: IBoundaryRule[]; loadIssues: IBoundaryLoadIssue[] }
  | { ok: false; message: string }
> {
  const abs = nodePath.resolve(cwd, raw);
  if (!existsSync(abs)) return { ok: false, message: `--${flag}: ${abs} does not exist.` };
  const loaded = await loadBoundaryRulesFromFile(abs);
  if (loaded.loadError !== undefined) {
    return { ok: false, message: `--${flag}: ${abs} failed to load — ${loaded.loadError}` };
  }
  const loadIssues = boundaryLoadIssuesFromFile(loaded, projectRoot, 'rule-file');
  if (loaded.rules.length === 0) {
    const detail = loadIssues.map((i) => `${boundaryLoadIssueLabel(i)}: ${i.issues.join('; ')}`).join(' | ');
    return {
      ok: false,
      message: `--${flag}: ${abs} defines no valid boundary rule${detail ? ` (${detail})` : ''}.`,
    };
  }
  return { ok: true, path: abs, rules: loaded.rules, loadIssues };
}

/** The envelope row an errored (never-evaluated) boundary rule becomes. */
function boundaryLoadIssueRow(issue: IBoundaryLoadIssue): IGateRuleResult {
  return {
    id: boundaryLoadIssueLabel(issue),
    type: 'boundary',
    status: 'error',
    severity: 'error',
    counts: {},
    violations: [],
    error: `${issue.file}: ${issue.kind} — ${issue.issues.join('; ')}`,
    coverage: boundaryLoadIssueCoverage(issue),
  };
}

/** One envelope row per selected rule (+ one errored row per load issue). */
function boundaryGateRules(result: IBoundaryCheckResult): IGateRuleResult[] {
  return [
    ...result.rules.map(
      (r): IGateRuleResult => ({
        id: r.ruleId,
        type: 'boundary',
        status: r.status,
        severity: r.severity === 'error' ? 'error' : 'warning',
        counts: {
          filesInScope: r.detail.filesInScope,
          edgesInScope: r.detail.edgesInScope,
          violations: r.violations.length,
          suppressed: r.detail.suppressed,
        },
        violations: [
          ...r.violations.map((v) => ({
            id: v.importSpecifier,
            file: v.file,
            line: v.line,
            message: v.message,
            ...(v.suggestedFix ? { hint: v.suggestedFix } : {}),
          })),
          ...r.staleExceptions.map((s) => ({ id: `exceptions[${s.index}]`, file: s.file, message: s.message })),
        ],
        ...(r.skipReason ? { skipReason: r.skipReason } : {}),
        coverage: r.coverage,
        // Round 13: the rule's expectEmpty acceptance (record B) — folded by the
        // envelope into the ONE settle, the same records the orchestrator
        // settled (`boundaryCheckCoverage`) — and its unit lines.
        ...(r.detail.unitAcceptance ? { unitAcceptance: r.detail.unitAcceptance } : {}),
        ...(r.detail.units ? { units: r.detail.units } : {}),
      }),
    ),
    ...result.loadIssues.map(boundaryLoadIssueRow),
  ];
}

/** The polyglot engine's contribution to a `--polyglot` run (its own section + one envelope row). */
function buildPolyglotSection(cwd: string, changedScope: IChangedScopeOptions | null): {
  readonly report: ReturnType<typeof buildPolyglotBoundaryReport>;
  readonly filtered: ReturnType<typeof filterViolationsToChangedScope<ReturnType<typeof buildPolyglotBoundaryReport>['violations'][number]>> | null;
  readonly violations: ReturnType<typeof buildPolyglotBoundaryReport>['violations'];
  readonly errors: number;
  readonly warnings: number;
  readonly rows: IGateRuleResult[];
} {
  const report = buildPolyglotBoundaryReport({ projectRoot: cwd });
  const filtered = changedScope ? filterViolationsToChangedScope(report.violations, changedScope) : null;
  const violations = filtered ? filtered.includedViolations : report.violations;
  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.filter((v) => v.severity === 'warning').length;
  // No polyglot language detected → the engine evaluated nothing: no row (a
  // row would claim an evaluation), and the run's coverage says so.
  const rows: IGateRuleResult[] =
    report.counts.rules > 0
      ? [
          {
            id: 'polyglot',
            type: 'boundary',
            status: errors > 0 ? 'failed' : 'passed',
            severity: 'error',
            counts: { rules: report.counts.rules, edges: report.counts.edges, violations: violations.length },
            violations: violations.map((v) => ({
              id: v.importSpecifier,
              file: v.fromFile,
              message: `[${v.ruleId}] ${v.suggestedFix}`,
            })),
            coverage: { unit: 'polyglot rules', expected: report.counts.rules, examined: report.counts.rules },
          },
        ]
      : [];
  return { report, filtered, violations, errors, warnings, rows };
}

/**
 * The exit-0 sentence handed to `verdictLine`. The `✓` form ONLY when nothing
 * was reported above: a warning / info violation or a dead selector unit (a
 * pattern that can never fire — the rule it sits in enforces less than it
 * says) is named on the verdict line instead, never followed by a ✓ —
 * policy-lint's convention for warnings.
 */
function boundaryCleanSentence(result: IBoundaryCheckResult, polyglotWarnings: number): string {
  const scope = result.changed ? ' introduced by changed files' : '';
  const warnings = result.counts.warning + polyglotWarnings;
  const info = result.counts.info;
  const dead = result.deadUnits.length;
  // Round 13: a LOCAL went-live expectEmpty marker is drift — reported above,
  // never under a ✓. A PACK marker that went live is INFO (its own block above
  // says so: the consumer cannot edit it), so it withholds nothing — the
  // sibling verdicts (`gates coverage`, the asset doctors) count local markers
  // only. An intended-empty unit is not drift: its acceptance prints below the ✓.
  const wentLive = result.wentLive.filter((u) => u.packageName === undefined).length;
  if (warnings === 0 && info === 0 && dead === 0 && wentLive === 0) {
    return `Verdict: OK — no boundary violations${scope}. ✓`;
  }
  const parts: string[] = [];
  if (warnings > 0) parts.push(`${warnings} warning(s)`);
  if (info > 0) parts.push(`${info} info finding(s)`);
  if (dead > 0) parts.push(`${dead} dead selector unit(s)`);
  const lead = warnings + info > 0 ? `no blocking boundary violations${scope}` : `no boundary violations${scope}`;
  const clauses: string[] = [];
  if (parts.length > 0) {
    const hint = dead > 0 ? ' (--fail-on-dead-units to fail on dead units)' : '';
    clauses.push(`${parts.join(', ')} reported above${hint}`);
  }
  if (wentLive > 0) clauses.push(`${wentLive} expectEmpty unit(s) went live (remove each stale expectEmpty marker)`);
  return `Verdict: ${lead} — ${clauses.join('; ')}.`;
}

/** The lead sentence of a NOT VERIFIED boundary verdict — says WHY nothing (or not everything) was proved. */
function boundaryNotVerifiedLead(result: IBoundaryCheckResult, env: IGateEnvelope): string {
  if (result.rulesConfigured === 0 && result.loadIssues.length === 0) {
    return 'Verdict: NOT VERIFIED — 0 boundary rules loaded, so nothing was checked.';
  }
  if (result.changed && (result.changed.escalationSuppressed.length ?? 0) > 0) {
    return `Verdict: NOT VERIFIED — the changeset edits the definition of ${result.changed.escalationSuppressed.length} rule(s) and --no-rule-escalation kept them out: changed-only cannot see a rule edit.`;
  }
  if (result.changed && env.coverage.expected === 0) {
    return 'Verdict: NOT VERIFIED — no changed source file is governed by a boundary rule; nothing was checked.';
  }
  const skipped = boundaryRulesCheckedNothing(result);
  const first = skipped[0];
  if (first) {
    return `Verdict: NOT VERIFIED — ${skipped.length} of ${result.rules.length} rules checked nothing (${first.ruleId}: ${first.skipReason ?? 'no governed file'})`;
  }
  return "Verdict: NOT VERIFIED — part of a rule's scope was never examined.";
}

async function checkBoundariesOnce(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const inspection = await inspectSharkcraft({ cwd });
  const ruleFilter = flagString(args, 'rule');

  const diffAgainst = flagString(args, 'diff-against');
  if (diffAgainst) return checkBoundaryRuleDiff(args, inspection, diffAgainst);

  let ruleFile: { path: string; rules: IBoundaryRule[]; loadIssues: IBoundaryLoadIssue[] } | undefined;
  const ruleFileArg = flagString(args, 'rule-file');
  if (ruleFileArg) {
    const loaded = await loadBoundaryRuleFileArg(cwd, inspection.projectRoot, ruleFileArg, 'rule-file');
    if (!loaded.ok) {
      process.stderr.write(`${loaded.message}\n`);
      return ExitCode.UsageError;
    }
    ruleFile = loaded;
  }

  const changedScope = readChangedScopeOptions(args, cwd);
  // THE boundary orchestrator — the same call finish, diff-check, quality and
  // both MCP boundary tools make, so none of them can disagree with this.
  const result = runBoundaryCheck(inspection, {
    ...(ruleFilter ? { onlyRuleId: ruleFilter } : {}),
    ...(ruleFile ? { ruleFile } : {}),
    ...(changedScope ? { changedScope } : {}),
    includeComments: flagBool(args, 'include-comments'),
    escalate: !flagBool(args, 'no-rule-escalation'),
    failOnDeadUnits: flagBool(args, 'fail-on-dead-units'),
    strict: flagBool(args, 'strict'),
  });

  if (result.unknownRuleId !== undefined) {
    const ids = result.availableRuleIds ?? [];
    const env = buildGateEnvelope('check boundaries', ExitCode.UsageError, [], result.runCoverage);
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: result.schema,
          ok: false,
          error: 'unknown-rule',
          ruleId: result.unknownRuleId,
          available: ids,
          verdict: planeVerdictForExit(env.exit),
          exitCode: env.exit,
          gate: env,
        }) + '\n',
      );
      return env.exit;
    }
    process.stderr.write(
      `No boundary rule "${result.unknownRuleId}". ${ruleFile ? `Rules in ${ruleFile.path}` : 'Configured rules'}: ${ids.length > 0 ? ids.join(', ') : '(none)'}\n`,
    );
    return env.exit;
  }

  // Settle first, render second: one envelope for text AND JSON.
  const polyglot = flagBool(args, 'polyglot') ? buildPolyglotSection(cwd, changedScope) : undefined;
  const polyRows = polyglot?.rows.length ?? 0;
  const ruleResults: IGateRuleResult[] = [...boundaryGateRules(result), ...(polyglot?.rows ?? [])];
  const expected = result.runCoverage.expected + polyRows;
  const runCoverage: IVerdictCoverage = {
    ...result.runCoverage,
    expected,
    examined: result.runCoverage.examined + polyRows,
    ...allowEmptyValve(args, expected),
  };
  const proposed = polyglot && polyglot.errors > 0 ? ExitCode.Failure : result.proposedExit;
  const env = buildGateEnvelope('check boundaries', proposed, ruleResults, runCoverage);
  const exit = env.exit;

  const wantFixSuggestions = flagBool(args, 'fix-suggestions');
  const fixSuggestions = wantFixSuggestions
    ? suggestBoundaryFixes(
        inspection,
        result.violations.map((v) => ({
          ruleId: v.ruleId,
          file: v.file,
          line: v.line,
          importSpecifier: v.importSpecifier,
          ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
        })),
      )
    : [];
  const suppressedExempt = result.suppressed.filter((s) => s.reason === 'exempt-file').length;
  const suppressedException = result.suppressed.length - suppressedExempt;
  // THE predicate (`boundaryRuleCheckedNothing`, via the orchestrator's
  // helpers MCP `check_boundaries` and `diff-check` read too): a failOnEmpty
  // rule's row is `failed`, yet it checked nothing and is never counted as
  // evaluated; a rule whose governed files went unread is PARTIAL, never
  // listed as "checked nothing".
  const skippedRules = boundaryRulesCheckedNothing(result);
  const evaluatedRules = boundaryRulesEvaluated(result);
  // Round 13 (K6): a rule accepted as intended-empty examined 0 files — THE
  // count above leaves it out, and it is printed apart, never dropped.
  const acceptedEmptyRules = boundaryRulesAcceptedEmpty(result);

  if (wantJson) {
    process.stdout.write(
      asJson({
        schema: result.schema,
        passed: exit === ExitCode.VerifiedPass,
        verdict: planeVerdictForExit(exit, result.counts.warning > 0 ? 'warnings' : undefined),
        exitCode: exit,
        ruleSource: result.ruleSource,
        rulesConfigured: result.rulesConfigured,
        rulesSelected: result.selectedRuleIds.length,
        // Rules that examined at least one governed file — never a skipped one,
        // never one accepted as intended-empty (counted in rulesAcceptedEmpty).
        rulesEvaluated: evaluatedRules,
        rulesAcceptedEmpty: acceptedEmptyRules.length,
        edgesEvaluated: result.scan.edges.length,
        zone: result.scan.zone ?? 'code',
        counts: result.counts,
        violations: result.violations,
        suppressed: result.suppressed,
        suppressedCounts: { exemptFile: suppressedExempt, exception: suppressedException },
        staleExceptions: result.staleExceptions,
        skipped: boundarySkippedRuleRows(result),
        deadUnits: result.deadUnits,
        // Round 13: every expectEmpty unit's state — accepted (intended empty),
        // stale (went live) — the units that fail this run, and the settled
        // acceptances (at exit 0; `gate.accepted` carries the same lines).
        intendedEmpty: result.intendedEmpty,
        wentLive: result.wentLive,
        failingUnits: result.failingUnits,
        accepted: env.accepted,
        coverage: result.rules.map((r) => r.detail),
        // Files the scan matched but could not read — each is folded into the
        // coverage of every rule whose scope it is in (never "examined").
        unreadFiles: result.scan.unread ?? [],
        loadIssues: result.loadIssues,
        ...(result.configuration ? { configuration: result.configuration } : {}),
        ...(result.rulesConfigured === 0 && result.loadIssues.length === 0
          ? { rules: 0, note: 'no boundary rules configured' }
          : {}),
        importGraph: summarizeImports(result.scan),
        ...(wantFixSuggestions ? { fixSuggestions } : {}),
        ...(result.changed
          ? {
              changedScope: {
                mode: result.changed.mode,
                changedFiles: result.changed.changedFiles,
                governedFiles: result.changed.governedFiles,
                includedViolations: result.violations,
                ignoredLegacyCount: result.changed.ignoredLegacyCount,
                ignoredLegacyByRule: result.changed.ignoredLegacyByRule,
                escalation: {
                  ruleIds: result.changed.escalatedRuleIds,
                  reasons: result.changed.escalation.reasons,
                },
                escalationSuppressed: result.changed.escalationSuppressed,
              },
            }
          : {}),
        ...(polyglot
          ? {
              polyglot: {
                counts: { errors: polyglot.errors, warnings: polyglot.warnings, rules: polyglot.report.counts.rules },
                languages: polyglot.report.languages,
                violations: polyglot.violations,
              },
            }
          : {}),
        gate: env,
      }) + '\n',
    );
    return exit;
  }

  if (polyglot) {
    process.stdout.write(header('Polyglot boundaries'));
    process.stdout.write(kv('languages', polyglot.report.languages.join(', ') || '(none)') + '\n');
    process.stdout.write(kv('rules', String(polyglot.report.counts.rules)) + '\n');
    process.stdout.write(kv('violations', `${polyglot.errors} errors, ${polyglot.warnings} warnings`) + '\n');
    if (polyglot.filtered) {
      process.stdout.write(kv('mode', polyglot.filtered.mode) + '\n');
      process.stdout.write(kv('changed files', String(polyglot.filtered.changedFiles.length)) + '\n');
      process.stdout.write(kv('legacy ignored', String(polyglot.filtered.ignoredLegacyCount)) + '\n');
    }
    if (polyglot.report.counts.rules === 0) {
      process.stdout.write('  (no polyglot language detected — the polyglot engine evaluated nothing)\n');
    }
    for (const v of polyglot.violations) {
      process.stdout.write(`  ${v.severity.toUpperCase().padEnd(8)} ${v.ruleId}  ${v.fromFile}\n`);
      process.stdout.write(`           import: "${v.importSpecifier}"\n`);
      process.stdout.write(`           ↳ ${v.suggestedFix}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(header('Boundaries'));
  const ruleParts = [
    `${result.rulesConfigured} configured${result.ruleSource.kind === 'rule-file' ? ` in ${result.ruleSource.path} (--rule-file)` : ''}`,
  ];
  if (result.changed) ruleParts.push(`${result.selectedRuleIds.length} in the changed scope`);
  ruleParts.push(`${evaluatedRules} evaluated`);
  if (acceptedEmptyRules.length > 0) ruleParts.push(`${acceptedEmptyRules.length} accepted as intended-empty`);
  if (skippedRules.length > 0) ruleParts.push(`${skippedRules.length} checked nothing`);
  if (result.loadIssues.length > 0) ruleParts.push(`${result.loadIssues.length} errored (NOT evaluated)`);
  process.stdout.write(kv('rules', ruleParts.join(', ')) + '\n');
  process.stdout.write(kv('files scanned', String(result.scan.filesScanned)) + '\n');
  process.stdout.write(
    kv('imports', `${result.scan.edges.length}${result.scan.zone === 'all' ? ' (raw text — comments included)' : ''}`) + '\n',
  );
  process.stdout.write(
    kv(
      'violations',
      `${result.counts.error} errors, ${result.counts.warning} warnings, ${result.counts.info} info` +
        (result.suppressed.length > 0
          ? `, ${result.suppressed.length} suppressed (${suppressedExempt} exempt-file, ${suppressedException} exception)`
          : ''),
    ) + '\n',
  );
  if (result.changed) {
    process.stdout.write(kv('mode', result.changed.mode) + '\n');
    process.stdout.write(
      kv('changed files', `${result.changed.changedFiles.length} (${result.changed.governedFiles.length} governed by a rule)`) + '\n',
    );
    process.stdout.write(kv('legacy ignored', String(result.changed.ignoredLegacyCount)) + '\n');
    if (result.changed.escalatedRuleIds.length > 0) {
      const why = result.changed.escalation.reasons.map((r) => `${r.file} changed (${r.kind})`).join('; ');
      process.stdout.write(
        kv('escalated', `${result.changed.escalatedRuleIds.length} rule(s) — ${why}: evaluated against the whole tree`) + '\n',
      );
    }
    if (result.changed.escalationSuppressed.length > 0) {
      process.stdout.write(
        kv(
          'escalation',
          `SUPPRESSED by --no-rule-escalation for ${result.changed.escalationSuppressed.length} rule(s) — the violations their edit created are NOT examined`,
        ) + '\n',
      );
    }
  }
  const config = result.configuration;
  if (
    config &&
    (!config.configured || config.unlistedDefaultFile !== undefined || config.missingListedFiles.length > 0)
  ) {
    process.stdout.write(kv('sharkcraft dir', config.sharkcraftDir ?? '(none found)') + '\n');
    for (const d of config.diagnostics) process.stdout.write(`  ! ${d}\n`);
  }
  process.stdout.write('\n');

  for (const v of result.violations) {
    const tag = v.severity.toUpperCase().padEnd(8);
    process.stdout.write(`  ${tag} ${v.ruleId.padEnd(28)} ${v.file}:${v.line}\n`);
    process.stdout.write(`           import: "${v.importSpecifier}"\n`);
    if (v.matchedForbidden && v.matchKind === 'subpath') {
      process.stdout.write(
        `           matched forbidden package: ${v.matchedForbidden} (subpath import — bare patterns cover subpaths; set forbiddenMatch: 'exact' for entrypoint-only)\n`,
      );
    } else if (v.matchedForbidden) {
      process.stdout.write(`           matched forbidden pattern: ${v.matchedForbidden}\n`);
    } else if (v.notAllowed) {
      process.stdout.write(`           not in allowed list for ${v.ruleId}\n`);
    }
    if (v.resolvedVia) process.stdout.write(`           resolved via tsconfig alias: ${v.resolvedVia}\n`);
    process.stdout.write(`           ${v.message}\n`);
    if (v.suggestedFix) process.stdout.write(`           ↳ ${v.suggestedFix}\n`);
  }
  for (const issue of result.loadIssues) {
    const what =
      issue.kind === 'invalid-rule'
        ? `rule '${issue.ruleId ?? `#${issue.index ?? '?'}`}' failed validation`
        : issue.kind === 'missing-file'
          ? 'listed rule file does not exist'
          : 'rule file failed to load';
    process.stdout.write(`  ERROR    ${issue.file}: ${what} — NOT evaluated\n`);
    for (const line of issue.issues) process.stdout.write(`           ${line}\n`);
  }
  for (const s of result.staleExceptions) {
    process.stdout.write(`  ERROR    ${s.ruleId.padEnd(28)} ${s.file}\n`);
    process.stdout.write(`           stale exception: ${s.message}\n`);
  }
  for (const r of skippedRules) {
    process.stdout.write(
      `  – ${r.ruleId} checked nothing — ${r.skipReason ?? 'no governed file'}${r.failedOnEmpty ? ' (failOnEmpty: counts as a failure)' : ''}\n`,
    );
  }
  for (const r of env.rules.filter((x) => x.status === 'partial')) {
    process.stdout.write(`  ~ ${r.id} PARTIAL — ${r.shortfall ?? 'part of its scope was never examined'}\n`);
  }
  if (result.deadUnits.length > 0) {
    process.stdout.write(
      `\nDead selector units (${result.deadUnits.length}) — each matches nothing, so it enforces nothing:\n`,
    );
    for (const d of result.deadUnits) {
      process.stdout.write(`  • [${d.unit}] ${d.ruleId}: ${d.selector} — ${d.reason}\n`);
    }
    if (!flagBool(args, 'fail-on-dead-units')) {
      process.stdout.write('  Pass --fail-on-dead-units to fail the run on them.\n');
    }
  }
  // Round 13: a marked unit whose target appeared — the fence went live, the
  // expectEmpty marker is stale. A LOCAL marker is drift, not a pass: ✓
  // withheld; it fails under --fail-on-dead-units / --strict. A PACK marker is
  // INFO in its own block — never a failure, and never the consumer's to remove
  // (the pack's author drops it in a release).
  const localWentLive = result.wentLive.filter((u) => u.packageName === undefined);
  const packWentLive = result.wentLive.filter((u) => u.packageName !== undefined);
  if (localWentLive.length > 0) {
    process.stdout.write(
      `\nexpectEmpty markers that went live (${localWentLive.length}) — each fence now has a target; remove the marker:\n`,
    );
    for (const u of localWentLive) {
      process.stdout.write(`  • [${u.unit}] ${u.ruleId}: ${u.selector} — ${u.reason}\n`);
    }
  }
  if (packWentLive.length > 0) {
    process.stdout.write(
      `\nINFO — pack expectEmpty markers that went live (${packWentLive.length}) — the fence now has a target; the pack's author removes the marker, and it never fails this run:\n`,
    );
    for (const u of packWentLive) {
      process.stdout.write(`  • [${u.unit}] ${u.ruleId}: ${u.selector} — ${u.reason}\n`);
    }
  }
  // R12-5.6 — INFO, never a finding (no verdict, no dead unit): a forbidden
  // pattern a sibling already covers, e.g. the `pkg` + `pkg/**` helper a bare
  // pattern used to need. The engine's coverage is the one answer.
  const redundant = result.rules.flatMap((r) =>
    r.detail.forbidden.flatMap((f) =>
      f.subsumedBy !== undefined ? [{ ruleId: r.ruleId, pattern: f.pattern, by: f.subsumedBy }] : [],
    ),
  );
  if (redundant.length > 0) {
    const e = redundant[0]!;
    process.stdout.write(
      `\nnote: ${redundant.length} forbidden pattern(s) already covered by a sibling pattern of the same rule — redundant, safe to delete (e.g. ${e.ruleId}: '${e.pattern}' is covered by '${e.by}'); \`shrk boundaries explain <ruleId>\` lists them.\n`,
    );
  }
  if (wantFixSuggestions && fixSuggestions.length > 0) {
    process.stdout.write('\nFix suggestions:\n');
    for (const s of fixSuggestions) {
      process.stdout.write(`  ${s.file}:${s.line}\n`);
      for (const sug of s.suggestions) process.stdout.write(`    ↳ ${sug}\n`);
    }
  }

  // The final line comes from the SETTLED verdict — the ✓ sentence only at 0.
  if (exit === ExitCode.Failure) {
    const parts: string[] = [];
    if (result.counts.error > 0) parts.push(`${result.counts.error} error violation(s)`);
    if (flagBool(args, 'strict') && result.counts.warning > 0) parts.push(`${result.counts.warning} warning(s) under --strict`);
    if (polyglot && polyglot.errors > 0) parts.push(`${polyglot.errors} polyglot error(s)`);
    if (result.loadIssues.length > 0) parts.push(`${result.loadIssues.length} errored rule(s)`);
    if (result.staleExceptions.length > 0) parts.push(`${result.staleExceptions.length} stale exception(s)`);
    const onEmpty = skippedRules.filter((r) => r.failedOnEmpty).length;
    if (onEmpty > 0) parts.push(`${onEmpty} rule(s) matched nothing (failOnEmpty)`);
    // THE units that fail this run (core `selectorUnitFails`, settled by the
    // orchestrator): an unmarked dead unit under --fail-on-dead-units, a local
    // went-live expectEmpty marker under it or --strict.
    const failingDead = result.failingUnits.filter((u) => u.state === UnitLivenessState.Dead).length;
    const failingLive = result.failingUnits.filter((u) => u.state === UnitLivenessState.WentLive).length;
    if (failingDead > 0) parts.push(`${failingDead} dead unit(s) (--fail-on-dead-units)`);
    if (failingLive > 0) {
      const why = flagBool(args, 'fail-on-dead-units') ? '--fail-on-dead-units' : '--strict';
      parts.push(`${failingLive} went-live expectEmpty unit(s) (${why})`);
    }
    // Round 13 (V1-U6): "violations" only when there are violations — a stale
    // exception or a dead unit over zero violations is the CHECK's attention.
    const violated = result.counts.error > 0 || (flagBool(args, 'strict') && result.counts.warning > 0) || (polyglot?.errors ?? 0) > 0;
    const lead = violated ? 'boundary violations need attention' : 'boundary check needs attention';
    process.stdout.write(`\nVerdict: ${lead} — ${parts.join(', ') || 'see above'}\n`);
    const tail = verdictLine(env, '');
    if (tail) process.stdout.write(`${tail}\n`);
    return exit;
  }
  const line = verdictLine(
    env,
    boundaryCleanSentence(result, polyglot?.warnings ?? 0),
    exit === ExitCode.NotVerified ? boundaryNotVerifiedLead(result, env) : undefined,
  );
  if (line) process.stdout.write(`\n${line}\n`);
  if (exit === ExitCode.NotVerified && env.coverage.expected === 0) {
    process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty selection explicitly.\n`);
  }
  return exit;
}

/**
 * `check boundaries --diff-against <candidate>` — what a proposed rule set would
 * ADD and REMOVE, before anyone commits a tightening. The same engine as the
 * gate, one scan for both sides (the orchestrator's `diffBoundaryRuleSets`).
 * Exit 1 when the proposal adds an error-severity violation, 2 when a
 * candidate rule's scope is dead (its delta proves nothing), 0 otherwise.
 */
async function checkBoundaryRuleDiff(
  args: ParsedArgs,
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
  raw: string,
): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const loaded = await loadBoundaryRuleFileArg(cwd, inspection.projectRoot, raw, 'diff-against');
  if (!loaded.ok) {
    process.stderr.write(`${loaded.message}\n`);
    return ExitCode.UsageError;
  }
  const onlyRuleId = flagString(args, 'rule');
  const diff = diffBoundaryRuleSets(
    inspection,
    { path: loaded.path, rules: loaded.rules, loadIssues: loaded.loadIssues },
    {
      ...(onlyRuleId ? { onlyRuleId } : {}),
      includeComments: flagBool(args, 'include-comments'),
      failOnDeadUnits: flagBool(args, 'fail-on-dead-units'),
    },
  );
  if (diff.unknownRuleId !== undefined) {
    process.stderr.write(`No boundary rule "${diff.unknownRuleId}" in the active or the candidate set.\n`);
    return ExitCode.UsageError;
  }
  const skippedCandidates = diff.candidateCoverage.filter((c) => c.status === 'skipped');
  const rows: IGateRuleResult[] = [
    ...diff.candidateCoverage.map((c): IGateRuleResult => {
      const added = diff.added.filter((v) => v.ruleId === c.ruleId);
      const per = diff.perRule.find((p) => p.ruleId === c.ruleId);
      return {
        id: c.ruleId,
        type: 'boundary',
        // A candidate that checked nothing and fails on empty WOULD fail the
        // gate: `failed` (skipReason kept), the same mapping as the gate's own
        // rows and the wiring plane — and the orchestrator proposes 1 for it.
        status:
          c.status === 'skipped'
            ? c.failedOnEmpty
              ? 'failed'
              : 'skipped'
            : added.length > 0
              ? 'failed'
              : 'passed',
        severity: c.severity === 'error' ? 'error' : 'warning',
        counts: {
          filesInScope: c.filesInScope,
          added: per?.added ?? 0,
          removed: per?.removed ?? 0,
          unchanged: per?.unchanged ?? 0,
        },
        violations: added.map((v) => ({ id: v.importSpecifier, file: v.file, line: v.line, message: v.message })),
        ...(c.skipReason ? { skipReason: c.skipReason } : {}),
        coverage: c.coverage,
        // Round 13: the candidate's expectEmpty acceptance and unit lines, as
        // on the gate's own rows.
        ...(c.unitAcceptance ? { unitAcceptance: c.unitAcceptance } : {}),
        ...(c.units ? { units: c.units } : {}),
      };
    }),
    ...diff.loadIssues.map(boundaryLoadIssueRow),
  ];
  // The candidate's dead selector units and expectEmpty units — settled by THE
  // unread re-settle `check boundaries` uses (round 13, P2) — and the units the
  // one predicate fails under `--fail-on-dead-units` (the orchestrator folds
  // them into `proposedExit`): the same valve and the same "no ✓ over a dead
  // unit" clean line as the main path (round 11 review R11-GAP-10).
  const candidateDead = diff.candidateCoverage.flatMap((c) => c.deadUnits);
  const proposed =
    diff.proposedExit === ExitCode.Failure
      ? ExitCode.Failure
      : skippedCandidates.length > 0
        ? ExitCode.NotVerified
        : ExitCode.VerifiedPass;
  const candidates = diff.candidateCoverage.length;
  const runCoverage: IVerdictCoverage = {
    unit: 'candidate rules',
    expected: candidates,
    examined: candidates - skippedCandidates.length,
    ...(skippedCandidates.length > 0
      ? {
          unexamined: skippedCandidates.map((c) => c.ruleId),
          reason: 'their from globs reach no governed file — the delta for them proves nothing',
        }
      : {}),
    ...(candidates === 0 ? { reason: 'no candidate rule is in the selected scope' } : {}),
    ...allowEmptyValve(args, candidates),
  };
  const env = buildGateEnvelope('check boundaries', proposed, rows, runCoverage);
  if (wantJson) {
    process.stdout.write(asJson({ ...diff, exitCode: env.exit, accepted: env.accepted, gate: env }) + '\n');
    return env.exit;
  }
  const fmt = (c: { error: number; warning: number; info: number }): string =>
    `${c.error} errors, ${c.warning} warnings, ${c.info} info`;
  process.stdout.write(header('Boundary rule diff (dry run — nothing written)'));
  process.stdout.write(kv('candidate', diff.candidateFile) + '\n');
  process.stdout.write(kv('rules added', diff.rulesAdded.join(', ') || '(none)') + '\n');
  process.stdout.write(kv('rules replaced', diff.rulesReplaced.join(', ') || '(none)') + '\n');
  process.stdout.write(kv('before', `${diff.before.rules} rule(s) — ${fmt(diff.before.counts)}`) + '\n');
  process.stdout.write(kv('after', `${diff.after.rules} rule(s) — ${fmt(diff.after.counts)}`) + '\n');
  process.stdout.write(kv('delta', `+${diff.added.length} added / -${diff.removed.length} removed / =${diff.unchanged} unchanged`) + '\n');
  process.stdout.write(
    kv('edges', `${diff.edgeLevel.newlyFlagged.length} newly flagged, ${diff.edgeLevel.noLongerFlagged.length} no longer flagged (any rule)`) + '\n',
  );
  process.stdout.write('\n  Per rule:\n');
  for (const p of diff.perRule) {
    process.stdout.write(`    +${p.added} -${p.removed} =${p.unchanged}  ${p.ruleId}\n`);
  }
  if (diff.added.length > 0) {
    process.stdout.write('\n  Added:\n');
    for (const v of diff.added.slice(0, 20)) {
      process.stdout.write(`    + ${v.severity.toUpperCase().padEnd(8)} ${v.ruleId}  ${v.file}:${v.line}  "${v.importSpecifier}"\n`);
    }
    if (diff.added.length > 20) process.stdout.write(`    … (${diff.added.length - 20} more — --json has every one)\n`);
  }
  if (diff.removed.length > 0) {
    process.stdout.write('\n  Removed:\n');
    for (const v of diff.removed.slice(0, 20)) {
      process.stdout.write(`    - ${v.severity.toUpperCase().padEnd(8)} ${v.ruleId}  ${v.file}:${v.line}  "${v.importSpecifier}"\n`);
    }
    if (diff.removed.length > 20) process.stdout.write(`    … (${diff.removed.length - 20} more — --json has every one)\n`);
  }
  for (const c of skippedCandidates) {
    process.stdout.write(`  – ${c.ruleId} checked nothing — ${c.skipReason ?? 'no governed file'}\n`);
  }
  for (const c of diff.candidateCoverage) {
    for (const d of c.deadUnits) process.stdout.write(`  • dead [${d.unit}] ${d.ruleId}: ${d.selector} — ${d.reason}\n`);
  }
  // Round 13: a candidate's expectEmpty marker whose target already exists.
  for (const u of diff.wentLive) {
    process.stdout.write(`  • went live [${u.unit}] ${u.ruleId}: ${u.selector} — ${u.reason}\n`);
  }
  for (const issue of diff.loadIssues) {
    process.stdout.write(`  ERROR    ${issue.file}: ${boundaryLoadIssueLabel(issue)} — ${issue.issues.join('; ')} — NOT evaluated\n`);
  }
  if (env.exit === ExitCode.Failure) {
    const addedErrors = diff.added.filter((v) => v.severity === 'error').length;
    const onEmpty = diff.candidateCoverage.filter((c) => c.failedOnEmpty === true).length;
    const failingDead = diff.failingUnits.filter((u) => u.state === UnitLivenessState.Dead).length;
    const failingLive = diff.failingUnits.filter((u) => u.state === UnitLivenessState.WentLive).length;
    const parts: string[] = [];
    if (addedErrors > 0) parts.push(`ADDS ${addedErrors} error-severity violation(s)`);
    if (diff.loadIssues.length > 0) parts.push(`has ${diff.loadIssues.length} invalid rule(s)`);
    if (onEmpty > 0) parts.push(`has ${onEmpty} rule(s) matching nothing (failOnEmpty — it would fail the gate)`);
    if (failingDead > 0) parts.push(`has ${failingDead} dead selector unit(s) (--fail-on-dead-units)`);
    if (failingLive > 0) parts.push(`has ${failingLive} went-live expectEmpty unit(s) (--fail-on-dead-units)`);
    process.stdout.write(`\nVerdict: the candidate ${parts.join(' and ') || 'fails'}.\n`);
    const tail = verdictLine(env, '');
    if (tail) process.stdout.write(`${tail}\n`);
    return env.exit;
  }
  // The ✓ ONLY when nothing was reported above: a dead unit or a went-live
  // marker printed a line earlier names what the candidate enforces less than
  // it says — the main path's convention (`boundaryCleanSentence`), never a ✓
  // under it. An intended-empty unit prints its acceptance below the ✓.
  const clauses: string[] = [];
  if (candidateDead.length > 0) {
    clauses.push(`${candidateDead.length} dead selector unit(s) reported above (--fail-on-dead-units to fail on them)`);
  }
  if (diff.wentLive.length > 0) {
    clauses.push(`${diff.wentLive.length} expectEmpty unit(s) went live (remove each stale expectEmpty marker)`);
  }
  const clean =
    clauses.length > 0
      ? `Verdict: the candidate adds no error-severity violation — ${clauses.join('; ')}.`
      : 'Verdict: the candidate adds no error-severity violation. ✓';
  const line = verdictLine(
    env,
    clean,
    env.exit === ExitCode.NotVerified
      ? skippedCandidates.length > 0
        ? 'Verdict: NOT VERIFIED — a candidate rule checked nothing, so its delta proves nothing.'
        : "Verdict: NOT VERIFIED — part of a candidate rule's scope could not be read, so its delta proves nothing."
      : undefined,
  );
  if (line) process.stdout.write(`\n${line}\n`);
  return env.exit;
}

// ────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────
// Subcommand: wiring — "declared but not wired" completeness checks
// ────────────────────────────────────────────────────────────────────────
const WIRING_CHECK_USAGE =
  'shrk check wiring [--changed-only] [--since <ref>] [--base <ref>] [--only <ids>] [--explain <ruleId>]\n' +
  '                  [--fix [--write]] [--json] [--strict]\n' +
  '  Cross-file "declared but not wired" completeness gate. Scope flags select rules by\n' +
  '  FOOTPRINT — a rule fires when the diff touches EITHER its declared or its registered\n' +
  '  side (so a registration edited in file B fires a rule declared in file A).\n' +
  '    --changed-only   run only rules whose footprint intersects the working diff\n' +
  '    --since <ref>    scope the diff to changes since <ref> (--base is a synonym)\n' +
  '    --only <ids>     run only these rule ids (comma-separated)\n' +
  '    --explain <id>   dry-run ONE rule and print the declared/registered sets it extracts\n' +
  '    --fix            plan the deterministic repair (append the token to its sink array);\n' +
  '                     dry-run by default, prints every edit AND any import it must add.\n' +
  '                     Refuses anything ambiguous — see `needs-import` in docs/wiring.md.\n' +
  '    --write          apply the planned edits (only meaningful with --fix)\n' +
  '  Exit: 0 verified pass · 1 violations · 2 not-verified (0 rules evaluated in scope).';

/**
 * The PROPOSED exit for a wiring run — the envelope then settles it against
 * every rule's coverage and the run's.
 *
 * The banner already said "Not a full green" when some rules were skipped, but
 * the code an agent chains on returned `0` — a rule that enforced NOTHING was
 * masked by its passing siblings. The verdict must match the sentence:
 *
 *   `1` violations (or a `failOnEmpty` skip, which the engine folds into the verdict)
 *   `2` rules were selected but none ran, OR anything skipped — partially
 *       verified is not verified
 *   `0` otherwise. That includes an EMPTY selection (no rule's footprint
 *       intersects the changeset): its run coverage (expected 0) settles it to
 *       2 unless `--allow-empty` accepted it. Proposing 2 there made the valve
 *       unreachable on exactly the case it exists for.
 */
function wiringExitCode(report: IWiringReport, evaluated: number, selected: number): number {
  if (report.verdict === 'errors') return ExitCode.Failure;
  if (report.skipped.length > 0) return ExitCode.NotVerified;
  if (evaluated === 0 && selected > 0) return ExitCode.NotVerified;
  return ExitCode.VerifiedPass;
}

/**
 * `check wiring --fix` — append a declared-but-unregistered token to its sink
 * array, but ONLY where the edit is mechanically unambiguous.
 *
 * Dry-run by default: it prints the exact diff it would make and writes
 * nothing. `--write` applies it. Anything the planner will not touch is listed
 * with the reason, because a gate that silently half-fixes is worse than one
 * that does nothing — the user must be able to see what was left.
 */
function runWiringFix(
  cwd: string,
  rules: readonly IWiringRule[],
  report: IWiringReport,
  write: boolean,
  wantJson: boolean,
  settle: (fixExit: number) => IGateEnvelope,
  excludeDirs: readonly string[] = [],
): number {
  const allEdits: IWiringFixEdit[] = [];
  const allSkips: IWiringFixSkip[] = [];
  // Read every file a sink could live in, once — over THE plane scan scope
  // the check itself walked (`planeScanExcludeDirs`). Reading more (the
  // SharkCraft dir) made a sink the check never saw look like a second
  // candidate, so a fixable token was refused as `ambiguous-sink-file`.
  const globs = [...new Set(rules.flatMap((r) => wiringGlobsOf(r)))];
  // A sink file over the read cap is not in `files`, so the planner cannot
  // find its array and refuses that edit (listed below); it never guesses.
  const files = [...readMatchingFiles(cwd, globs, new Set(excludeDirs)).files.entries()].map(([path, content]) => ({
    path,
    content,
  }));

  for (const rule of rules) {
    const violations = report.violations.filter((v) => v.ruleId === rule.id);
    if (violations.length === 0) continue;
    const plan = planWiringFix(rule, violations, files);
    allEdits.push(...plan.edits);
    allSkips.push(...plan.skipped);
  }

  // One write per file: the planner threads each file's content forward, so the
  // LAST edit for a path carries every earlier insertion.
  const finalByFile = new Map<string, string>();
  for (const e of allEdits) finalByFile.set(e.file, e.nextContent);
  let written = 0;
  if (write) {
    for (const [rel, content] of finalByFile) {
      writeFileSync(nodePath.resolve(cwd, rel), content, 'utf8');
      written += 1;
    }
  }

  // ONE proposed exit for text and JSON (they used to differ: JSON only failed
  // when nothing at all was fixable). An unfixable violation still means the
  // gate is red. Then SETTLED against the check's own rule + run coverage: the
  // fix cannot examine what the rules never examined.
  const fixExit = allSkips.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass;
  const env = settle(fixExit);

  if (wantJson) {
    process.stdout.write(
      asJson({
        schema: 'sharkcraft.wiring-fix/v1',
        applied: write,
        filesWritten: written,
        edits: allEdits.map(({ nextContent: _drop, ...rest }) => rest),
        skipped: allSkips,
        exitCode: env.exit,
        gate: env,
      }) + '\n',
    );
    return env.exit;
  }

  process.stdout.write(header(write ? 'Wiring fix (applied)' : 'Wiring fix (dry run)'));
  if (allEdits.length === 0 && allSkips.length === 0) {
    process.stdout.write('  Nothing to fix — no declared-but-unregistered tokens.\n');
    const line = verdictLine(
      env,
      '',
      '--fix repairs declared-but-unregistered tokens only; it cannot examine what the rules never examined.',
    );
    if (line) process.stdout.write(`\n${line}\n`);
    return env.exit;
  }
  for (const e of allEdits) {
    process.stdout.write(`  ${write ? 'wrote  ' : 'would add'} ${e.token} → ${e.file}:${e.line}\n`);
    // Show BOTH halves of the edit. An array append whose import is invisible
    // in the preview is exactly how the reviewer approves a change they have
    // not actually seen — and the import is the half that decides whether the
    // result compiles.
    if (e.importInsert !== undefined) {
      process.stdout.write(`      + ${e.importInsert}${e.importLine !== undefined ? `   (line ${e.importLine})` : ''}\n`);
    }
    process.stdout.write(`      + ${e.insert}${e.importInsert !== undefined ? `   (line ${e.line})` : ''}\n`);
  }
  if (allSkips.length > 0) {
    process.stdout.write(`\n  Left untouched (${allSkips.length}) — not mechanically unambiguous:\n`);
    for (const sk of allSkips) {
      process.stdout.write(`    • ${sk.token}  [${sk.reason}] ${sk.detail}\n`);
    }
  }
  process.stdout.write(
    write
      ? `\n${written} file(s) written. Re-run \`shrk check wiring\` to confirm, and review the diff.\n`
      : '\nDry run — nothing written. Re-run with `--write` to apply.\n',
  );
  // The final line and the exit come from the SETTLED verdict: an unfixable
  // violation is 1, and a fix over a partially-examined scope is never 0.
  const tail = verdictLine(env, '');
  if (tail) process.stdout.write(`\n${tail}\n`);
  return env.exit;
}

async function checkWiring(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  // `--help` / `-h` never reaches here: the dispatcher answers it (dispatch/help-intercept.ts).
  const wantJson = flagBool(args, 'json');
  const changedOnly = flagBool(args, 'changed-only');
  // `--base <ref>` is an accepted synonym for `--since <ref>` (a25 §3.2) —
  // scope the footprint diff to changes since an arbitrary ref.
  const since = flagString(args, 'since') ?? flagString(args, 'base');
  const only = flagString(args, 'only');

  // Distinguish "config is invalid" from "config valid with no wiring rules":
  // an invalid config (e.g. a malformed wiringRule) must NOT fail open with a
  // misleading "no rules configured" + exit 0.
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) {
    // The gate never STARTED — its rules live in the config it could not load —
    // so this is a usage error (3), never `1`: a CI step reads 1 as "violations
    // found". `policy-lint` and `gates check` answer the same config the same way.
    const msg = loaded.error.message;
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.wiring/v1',
          error: msg,
          rules: [],
          violations: [],
          diagnostics: [msg],
          verdict: 'usage-error',
          exitCode: ExitCode.UsageError,
        }) + '\n',
      );
      return ExitCode.UsageError;
    }
    process.stdout.write(header('Wiring check'));
    process.stdout.write(`  ✗ Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
    return ExitCode.UsageError;
  }
  const rules = loaded.value.config.wiringRules ?? [];
  const planeDiagnostics = loaded.value.planeDiagnostics;
  // A pack wiring rule the merge seam rejected is a configured rule that did
  // NOT run — an errored row, exit 1 (round 12 review, R12-X1).
  const rejectedAll = seamRejectedRules(loaded.value, ['wiring']);

  // `--explain <ruleId>`: dry-run ONE rule and print the declared + registered
  // sets it extracts (file:line), the set-difference, and the verdict — the
  // author-loop view of what the gate sees, without re-running the whole gate.
  if (args.flags.has('explain')) {
    const explainId = flagString(args, 'explain');
    if (!explainId) {
      process.stderr.write('Usage: shrk check wiring --explain <ruleId> [--json]\n');
      return ExitCode.UsageError;
    }
    const rule = rules.find((r) => r.id === explainId);
    const rejectedRule = rule ? undefined : rejectedAll.find((r) => r.id === explainId);
    if (rejectedRule) {
      // Declared by a pack, refused by the merge seam: there is nothing to
      // dry-run, and the rule never runs — a failure, never a not-found.
      const message = rejectedRule.error ?? 'failed validation';
      if (wantJson) {
        process.stdout.write(
          asJson({ ok: false, error: 'rejected', ruleId: explainId, message, exitCode: ExitCode.Failure }) + '\n',
        );
      } else {
        process.stdout.write(`Wiring rule "${explainId}" was REJECTED — ${message}\n`);
      }
      return ExitCode.Failure;
    }
    if (!rule) {
      const ids = rules.map((r) => r.id);
      if (wantJson) {
        process.stdout.write(
          asJson({ ok: false, error: 'not-found', ruleId: explainId, available: ids }) + '\n',
        );
        return 2;
      }
      process.stderr.write(
        `No wiring rule "${explainId}". Configured rules: ${ids.length > 0 ? ids.join(', ') : '(none)'}\n`,
      );
      return ExitCode.UsageError;
    }
    // `check wiring` is a verdict verb, so its `--explain` returns the explained
    // rule's SETTLED exit (0 / 1 / 2) — never a 0 over a rule the gate reports
    // partial. `wiring explain` / `gates explain` stay informational (0).
    const explained = explainWiring(cwd, rule, { excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir) });
    renderWiringExplain(explained, wantJson);
    return settleWiringExplain(explained).exit;
  }

  if (rules.length === 0 && rejectedAll.length === 0) {
    // Nothing declared is NOT a pass — the request covered zero rules, so it
    // proved nothing: `2`, unless the caller accepts the empty set explicitly.
    const env = buildGateEnvelope('check wiring', ExitCode.VerifiedPass, [], {
      unit: 'wiring rules',
      expected: 0,
      examined: 0,
      reason: 'no wiringRules[] declared',
      ...allowEmptyValve(args, 0),
    });
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.wiring/v1',
          rules: [],
          violations: [],
          verdict: env.exit === ExitCode.VerifiedPass ? 'pass' : 'not-verified',
          exitCode: env.exit,
          gate: env,
        }) + '\n',
      );
      return env.exit;
    }
    process.stdout.write(header('Wiring check'));
    process.stdout.write(
      '  No wiring rules configured. Declare `wiringRules[]` in sharkcraft.config.ts to enable\n' +
        '  cross-file "declared but not wired" checks (see docs/wiring.md).\n',
    );
    process.stdout.write(`\n${verdictLine(env, 'Nothing declared — accepted.')}\n`);
    if (env.exit !== ExitCode.VerifiedPass) {
      process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty rule set explicitly.\n`);
    }
    return env.exit;
  }

  let changedFiles: readonly string[] | undefined;
  if (changedOnly || since) {
    const changed = resolveChangedFiles({
      projectRoot: cwd,
      ...(since ? { since } : {}),
      ...(changedOnly && !since ? { includeWorktree: true } : {}),
    });
    changedFiles = changed.files;
  }

  const reportRaw = runWiring(cwd, rules, {
    // THE plane scan scope, so this verb and `gates check` walk the same tree.
    excludeDirs: planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir),
    ...(changedOnly || since ? { changedOnly: true, changedFiles: changedFiles ?? [] } : {}),
    ...(only ? { only: only.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
  });
  // Surface pack-plane merge notes (missing/invalid pack rule files, dropped
  // collisions) alongside the rule engine's own misconfiguration diagnostics.
  const report =
    planeDiagnostics.length > 0
      ? { ...reportRaw, diagnostics: [...reportRaw.diagnostics, ...planeDiagnostics] }
      : reportRaw;

  // Truthful evaluation accounting so a subset run never reads as a full green.
  //   configured      — every wiring rule declared (the honest denominator).
  //   selected        — rules that survived --changed-only / --only narrowing.
  //   evaluated        — rules that actually ran a comparison (globs matched >0 files).
  //   skippedByScope  — configured − selected (dropped by the diff/only narrowing).
  //   matchedNothing  — selected − evaluated (in scope but matched 0 files).
  //   rejected        — pack rules the merge seam refused: declared, never run.
  const onlyIds = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const rejected = onlyIds ? rejectedAll.filter((r) => onlyIds.includes(r.id)) : rejectedAll;
  const configured = rules.length + rejectedAll.length;
  const selected = report.rules.length + rejected.length;
  const evaluated = report.evaluated;
  // Round 13 (K6): `report.evaluated` counts a rule accepted as intended-empty
  // (so the `evaluated === 0` guard never reads an accepted plan as "nothing
  // ran"), but that rule examined 0 files — every PRINTED "evaluated" count
  // leaves it out and names it apart: `N evaluated, M accepted as intended-empty`.
  const acceptedEmpty = report.acceptedEmpty;
  const evaluatedShown = evaluated - acceptedEmpty;
  const acceptedNote = acceptedEmptyNote(acceptedEmpty);
  const skippedByScope = Math.max(0, configured - selected);
  const matchedNothing = Math.max(0, report.rules.length - evaluated);
  const notVerified = Math.max(0, configured - evaluated);
  const allEvaluated = evaluated === configured;
  const scopeNote = changedOnly || since ? ' by --changed-only' : '';
  const parts: string[] = [];
  if (skippedByScope > 0) parts.push(`${skippedByScope} skipped${scopeNote}`);
  if (matchedNothing > 0) parts.push(`${matchedNothing} matched no files`);
  if (rejected.length > 0) parts.push(`${rejected.length} rejected at the pack-plane merge seam`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';

  // Rule ids selected by footprint (declared OR registered side intersecting the
  // diff) — positive evidence the gate ran the RIGHT rules for the change's
  // blast radius, not just the rules whose literal files were edited (a25 §3.2).
  const selectedRuleIds = report.rules.map((r) => r.ruleId);
  const scoped = changedOnly || since !== undefined;

  // Settle first, render second. The envelope is built for text AND JSON (and
  // --fix), so every path returns the SAME settled exit, and a subset rule that
  // passed over registered tokens its declared selector never produced reads
  // `partial` — exit 2, naming them — instead of a green 0.
  const proposed =
    rejected.length > 0 ? ExitCode.Failure : wiringExitCode(report, evaluated, report.rules.length);
  const unexaminedRules = [
    ...report.skipped.map((s) => s.ruleId),
    ...report.rules.filter((r) => r.status === 'error').map((r) => r.ruleId),
    ...rejected.map((r) => r.id),
  ];
  const ruleResults: IGateRuleResult[] = [...report.rules.map((r): IGateRuleResult => {
    const skip = report.skipped.find((s) => s.ruleId === r.ruleId);
    return {
      id: r.ruleId,
      type: 'wiring',
      status: r.status,
      severity: r.severity,
      counts: { declared: r.declaredCount, registered: r.registeredCount },
      violations: r.violations.map((v) => ({
        id: v.token,
        file: v.file,
        line: v.line,
        ...(v.message ? { message: v.message } : {}),
        ...(v.hint ? { hint: v.hint } : {}),
      })),
      ...(skip ? { skipReason: skip.reason } : {}),
      ...(r.error ? { error: r.error } : {}),
      coverage: r.coverage,
      // The rule's `expectEmpty` acceptance and unit lines (round 13, lane G),
      // folded into the envelope's one settle — the accepted line comes from it.
      ...(r.unitAcceptance !== undefined ? { unitAcceptance: r.unitAcceptance } : {}),
      ...(r.units !== undefined ? { units: r.units } : {}),
    };
  }), ...rejected];
  const runCoverage: IVerdictCoverage = {
    unit: 'wiring rules',
    expected: selected,
    examined: selected - unexaminedRules.length,
    ...(unexaminedRules.length > 0
      ? { unexamined: unexaminedRules, reason: 'checked nothing or could not run' }
      : {}),
    ...(selected === 0
      ? { reason: scoped ? 'no rule footprint intersects the changeset' : 'no rule selected' }
      : {}),
    ...allowEmptyValve(args, selected),
  };
  const env = buildGateEnvelope('check wiring', proposed, ruleResults, runCoverage);
  const exit = env.exit;

  // ── --fix: deterministic, heavily-guarded autofix ─────────────────────
  // The fix repairs declared-but-unregistered tokens; it cannot examine what
  // the rules never examined. So its exit is settled against the SAME rule and
  // run coverage: "Nothing to fix" over a partial rule is 2, never 0.
  if (flagBool(args, 'fix')) {
    return runWiringFix(
      cwd,
      rules,
      report,
      flagBool(args, 'write'),
      wantJson,
      (fixExit) => buildGateEnvelope('check wiring', fixExit, ruleResults, runCoverage),
      planeScanExcludeDirs(cwd, loaded.value.sharkcraftDir),
    );
  }

  if (wantJson) {
    // Carry the honest counts so a machine consumer can tell "0 evaluated" from
    // a real green, and see how many rules the scope skipped + which fired.
    process.stdout.write(
      asJson({
        ...report,
        // The plane verdict derives from the SETTLED exit — never `pass` next
        // to exitCode 2.
        verdict: planeVerdictForExit(exit, report.verdict),
        configured,
        selected,
        evaluated,
        skippedByScope,
        matchedNothing,
        notVerified,
        selectedRuleIds,
        // Pack wiring rules the merge seam refused — errored rows in `gate.rules`.
        rejected: rejected.map((r) => ({ id: r.id, error: r.error ?? null })),
        // Distinguish verified-pass / failure / not-verified for a chained gate.
        exitCode: exit,
        // One shape across every plane — see docs/gate-json.md.
        gate: env,
      }) + '\n',
    );
    return exit;
  }

  process.stdout.write(header('Wiring check'));
  if (rejected.length > 0) {
    process.stdout.write(
      `  ✗ ${rejected.length} pack wiring rule(s) failed validation at the pack-plane merge seam — NOT evaluated, FAILED:\n`,
    );
    for (const r of rejected) process.stdout.write(`    ✗ ${r.id} — ${r.error ?? 'failed validation'}\n`);
    process.stdout.write('    `shrk packs contributions` names every rejected entry.\n');
  }
  // `evaluated` counts rules that actually ran a comparison (globs matched >0
  // files). When 0 rules evaluated, say so loudly — "checked nothing" must
  // never read as the green "every token is wired" pass, and the exit code
  // says NOT verified (`2`) too, not a lying `0` — unless the caller accepted
  // an empty scope with --allow-empty, which is printed as such.
  if (evaluated === 0) {
    process.stdout.write(
      exit === ExitCode.VerifiedPass
        ? `  0 rules in scope — ${configured} rule(s) configured${breakdown}.\n`
        : `  ! 0 rules evaluated — NOT verified. ${configured} rule(s) configured${breakdown}; ` +
            'none ran a comparison in scope. Wiring was not checked — this is not a pass.\n',
    );
    for (const sk of report.skipped) {
      process.stdout.write(
        `  ${sk.failed ? '✗' : '–'} ${sk.ruleId} ${sk.failed ? 'FAILED' : 'SKIPPED'} — ${sk.reason}\n`,
      );
    }
    // THE empty-rule advice (round 13) — the 0-evaluated branch returned
    // before the only advice site, so a rule that matched nothing got none.
    for (const a of emptyRuleAdviceLines(report.skipped.map((sk) => ({ fails: sk.failed === true })))) {
      process.stdout.write(`  ${a}.\n`);
    }
    const line = verdictLine(env, 'Nothing in scope — accepted.');
    if (line) process.stdout.write(`\n${line}\n`);
    if (selected === 0 && exit === ExitCode.NotVerified) {
      process.stdout.write(`  Pass --${ALLOW_EMPTY_FLAG} to accept an empty changeset explicitly.\n`);
    }
    return exit;
  }
  process.stdout.write(kv('rules evaluated', `${evaluatedShown} of ${configured}${acceptedNote}${breakdown}`) + '\n');
  if (scoped && selectedRuleIds.length > 0) {
    // Show WHICH rules the diff's footprint selected so the scoping is provable,
    // not indistinguishable from plain changed-file scoping.
    process.stdout.write(
      kv('selected by footprint', selectedRuleIds.join(', ')) + '\n',
    );
  }
  const errors = report.violations.filter((v) => v.severity === 'error').length;
  const warnings = report.violations.filter((v) => v.severity === 'warning').length;
  process.stdout.write(kv('violations', `${errors} error(s), ${warnings} warning(s)`) + '\n');
  // Every rule that ran clean, WITH both counts, so a pass can be compared to
  // what it covered. A subset rule whose declared selector never produced some
  // registered tokens is `partial`, and says which ones it never examined.
  // THE shared unit-state block (round 13, K2): a dead glob of a rule that
  // still matched, and a LOCAL expectEmpty marker whose target appeared, are
  // listed below and withhold the ✓ (exit unchanged); a pack marker is INFO.
  const unitNotes = unitStateNotes(
    report.rules.map((r) => ({
      id: r.ruleId,
      ...(r.unitLiveness !== undefined ? { unitLiveness: r.unitLiveness } : {}),
      reportedEmpty: report.skipped.some((s) => s.ruleId === r.ruleId),
    })),
  );
  const cleanRules = env.rules.filter((r) => r.status === 'passed' || r.status === 'partial');
  if (cleanRules.length > 0) {
    process.stdout.write('\n');
    for (const r of cleanRules) {
      const counts = `declared ${r.counts['declared'] ?? 0} / registered ${r.counts['registered'] ?? 0}`;
      process.stdout.write(
        r.status === 'passed'
          ? `  ${unitNotes.staleIds.has(r.id) ? '⚠' : '✓'} ${r.id}  (${counts})\n`
          : `  ~ ${r.id}  (${counts}) — PARTIAL: ${r.shortfall ?? 'not fully examined'}\n`,
      );
    }
  }
  // Misconfigured rules (uncompilable pattern / no capture group) — surface
  // them loudly; a broken rule must never read as a silent green.
  if (report.diagnostics.length > 0) {
    process.stdout.write('\nMisconfigured rules:\n');
    for (const d of report.diagnostics) process.stdout.write(`  ! ${d}\n`);
  }
  // Rules that checked NOTHING, reported per-rule. `matchedNothing` gives the
  // count; this names them, because "which rule went stale" is the actionable
  // half. A `failOnEmpty` rule turns its own skip into a hard failure.
  if (report.skipped.length > 0) {
    process.stdout.write('\nRules that checked nothing:\n');
    for (const sk of report.skipped) {
      process.stdout.write(
        `  ${sk.failed ? '✗' : '–'} ${sk.ruleId} ${sk.failed ? 'FAILED' : 'SKIPPED'} — ${sk.reason}\n`,
      );
    }
    // THE empty-rule advice (round 13) — one sentence per REAL `fails` value,
    // from the shared renderer: a failing (failOnEmpty) rule was told nothing.
    for (const a of emptyRuleAdviceLines(report.skipped.map((sk) => ({ fails: sk.failed === true })))) {
      process.stdout.write(`  ${a}.\n`);
    }
    process.stdout.write('  Run `shrk gates coverage` to audit every plane at once.\n');
  }
  // A sink that extracted 0 ids while the source had some is a real failure, but
  // almost always a stale SINK glob — say so instead of listing N "unwired"
  // tokens with no explanation.
  for (const r of report.rules) {
    if (!r.emptySink) continue;
    process.stdout.write(
      `\n  ! ${r.ruleId}: the registered side extracted 0 ids while ${r.declaredCount} were declared —\n` +
        `    every declared token "fails". Check the registered glob before chasing the tokens.\n`,
    );
    // When the engine knows WHY the sink came back empty, say it here — the
    // generic advice above would otherwise send the reader to inspect a glob
    // that is perfectly fine.
    if (r.sinkHint) process.stdout.write(`    → ${r.sinkHint}\n`);
  }
  // The final line comes from the SETTLED verdict only — never a ✓ sentence
  // printed directly, so the banner cannot disagree with `$?`.
  process.stdout.write(unitNotes.text);
  const notFull =
    `No wiring violations among the ${evaluatedShown} rule(s) evaluated${acceptedNote} — ` +
    `${notVerified} of ${configured} NOT verified${breakdown}. Not a full green.`;
  // A failOnEmpty skip produces no violation object but IS a failure, so it
  // falls through to the failure tail below.
  if (
    report.violations.length === 0 &&
    report.diagnostics.length === 0 &&
    report.verdict !== 'errors'
  ) {
    // Every configured rule ran — the earned full green. A subset ran — no
    // violations AMONG WHAT RAN, never the unqualified success sentence.
    const line = verdictLine(
      env,
      allEvaluated
        ? qualifyCleanForUnits('No wiring violations — every declared token is registered. ✓', unitNotes)
        : notFull,
      proposed === ExitCode.NotVerified ? notFull : undefined,
    );
    if (line) process.stdout.write(`\n${line}\n`);
    return exit;
  }
  // Group by rule for a readable report.
  for (const r of report.rules) {
    if (r.violations.length === 0) continue;
    process.stdout.write(`\n[${r.severity}] ${r.ruleId}${r.description ? ' — ' + r.description : ''}\n`);
    process.stdout.write(
      `  declared ${r.declaredCount} / registered ${r.registeredCount} — ${r.violations.length} not wired:\n`,
    );
    for (const v of r.violations.slice(0, 50)) {
      const where = `(${v.file}:${v.line})`;
      const hop = v.hop !== undefined ? ` [hop ${v.hop}]` : '';
      process.stdout.write(
        v.message ? `    • ${v.message}  ${where}${hop}\n` : `    • ${v.token}  ${where}${hop}\n`,
      );
    }
    if (r.violations.length > 50) {
      process.stdout.write(`    … (${r.violations.length - 50} more)\n`);
    }
    const hint = r.violations.find((v) => v.hint)?.hint;
    if (hint) process.stdout.write(`    → ${hint}\n`);
  }
  const tail = verdictLine(env, '');
  if (tail) process.stdout.write(`\n${tail}\n`);
  return exit;
}

/**
 * `shrk check orphans [--since <ref>] [--staged]`: first-class, diff-robust
 * reverse-closure over REMOVED files. Reads the deleted files from the diff
 * (vs `--since`, or the staged index with `--staged`) and queries the
 * code-graph snapshot for surviving files that still import them or reference a
 * symbol they declared — alias-resolved, incl. barrel re-exports. Each survivor
 * is an error with `file:line`; the type checker misses a deleted barrel
 * re-export or string-keyed registration, so this is a write-safety guard an
 * agent can't replicate natively. Generalizes `impact --deleted`; pairs with
 * the composite `finish` gate.
 */
async function checkOrphans(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const since = flagString(args, 'since');
  const staged = flagBool(args, 'staged');
  const scan = await computeDeletedOrphans(cwd, {
    ...(since ? { since } : {}),
    ...(staged ? { staged: true } : {}),
  });

  if (!scan.ok) {
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.deleted-orphans/v1',
          error: scan.error,
          reason: scan.reason,
          orphans: [],
        }) + '\n',
      );
      return 2;
    }
    process.stdout.write(header('Orphan check'));
    process.stdout.write(
      scan.reason === 'diff-unavailable'
        ? `  ✗ Cannot resolve diff: ${scan.error ?? 'unknown'}\n`
        : `  ✗ ${scan.error ?? 'orphan check unavailable'}\n`,
    );
    return 2;
  }

  const scopeLabel = staged ? 'staged' : `vs ${scan.ref}`;
  // What the scan examined against what the delete asked it to — ONE
  // authority (deletedOrphanCoverage): every deleted source file the graph
  // indexes is expected; one the index does not know is unexamined.
  const coverage = deletedOrphanCoverage(scan);

  // Nothing deleted → there is nothing to check, and "checked nothing" must
  // never read as "verified clean": a LOUD skip that exits 2 (not verified), in
  // text AND JSON. A hook that runs this on every commit accepts the empty diff
  // EXPLICITLY with --allow-empty, which is printed as an acceptance.
  if (scan.deleted.length === 0) {
    const emptyEnv = buildGateEnvelope('check orphans', ExitCode.VerifiedPass, [], {
      ...coverage,
      ...allowEmptyValve(args, coverage.expected),
    });
    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.deleted-orphans/v1',
          skipped: true,
          ref: scan.ref,
          resolvedDeleted: [],
          unresolvedDeleted: [],
          orphans: [],
          diagnostics: [`no deleted files (${scopeLabel}) — nothing to check`],
          exitCode: emptyEnv.exit,
          gate: emptyEnv,
        }) + '\n',
      );
      return emptyEnv.exit;
    }
    process.stdout.write(header('Orphan check'));
    process.stdout.write(`  ! Nothing deleted (${scopeLabel}) — orphan check skipped.\n`);
    process.stdout.write(`\n${verdictLine(emptyEnv, 'Nothing deleted — accepted.')}\n`);
    if (emptyEnv.exit !== ExitCode.VerifiedPass) {
      process.stdout.write(
        `  Pass --${ALLOW_EMPTY_FLAG} to accept an empty diff explicitly (e.g. in a per-commit hook).\n`,
      );
    }
    return emptyEnv.exit;
  }

  const report = scan.report!;
  // The index can only answer for the deleted SOURCE files it knows. One it
  // does not know (the index predates it, or was rebuilt after the delete)
  // had its importers never checked: it is expected but unexamined, so a clean
  // result settles to 2 and names it. A deleted README is outside the scope.
  const env = buildGateEnvelope(
    'check orphans',
    report.orphans.length > 0 ? ExitCode.Failure : ExitCode.VerifiedPass,
    [],
    { ...coverage, ...allowEmptyValve(args, coverage.expected) },
  );
  const exit = env.exit;
  if (wantJson) {
    process.stdout.write(
      asJson({
        ...report,
        ...(scan.indexDivergence ? { indexDivergence: scan.indexDivergence } : {}),
        exitCode: exit,
        gate: env,
      }) + '\n',
    );
    return exit;
  }

  process.stdout.write(header('Orphan check'));
  process.stdout.write(kv('deleted files', `${scan.deleted.length} (${scopeLabel})`) + '\n');
  process.stdout.write(kv('coverage', formatCoverage(coverage)) + '\n');
  // The importer side (a file added or edited since the index was built was
  // never read for imports) and the lead explaining a partial scope — worded
  // once and shared with `impact --deleted`, which answers the same question
  // from the same scan.
  const notes = deletedOrphanScopeNotes(scan, coverage, 'shrk check orphans');
  if (notes.index !== undefined) process.stdout.write(kv('index', notes.index) + '\n');
  const unindexedLead = notes.lead;
  if (report.orphans.length === 0) {
    for (const d of report.diagnostics.slice(0, 5)) process.stdout.write(`  ! ${d}\n`);
    const line = verdictLine(
      env,
      'No orphaned importers — nothing still references the deleted code. ✓',
      unindexedLead,
    );
    if (line) process.stdout.write(`\n${line}\n`);
    if (exit === ExitCode.NotVerified && coverage.expected === 0) {
      process.stdout.write(
        `  Pass --${ALLOW_EMPTY_FLAG} to accept a delete with no indexed source files explicitly.\n`,
      );
    }
    return exit;
  }
  process.stdout.write(
    `\n${report.orphans.length} surviving importer(s) still reference deleted code:\n`,
  );
  for (const o of report.orphans.slice(0, 100)) {
    const loc = o.path ? `${o.path}${o.line ? `:${o.line}` : ''}` : o.id;
    const detail = o.via === 'reference' && o.symbol ? `references \`${o.symbol}\`` : 'imports';
    process.stdout.write(`  ✗ ${loc} ${detail} from deleted ${o.deletedFile}\n`);
  }
  if (report.orphans.length > 100) {
    process.stdout.write(`  … (${report.orphans.length - 100} more)\n`);
  }
  for (const d of report.diagnostics.slice(0, 5)) process.stdout.write(`  ! ${d}\n`);
  const tail = verdictLine(env, '');
  if (tail) process.stdout.write(`${tail}\n`);
  return exit;
}

// Main shrk check + subcommands
// ────────────────────────────────────────────────────────────────────────
export const checkCommand: ICommandHandler = {
  name: 'check',
  // Declared for the dispatcher guard, `help` and the command index (round 11
  // §5.2): any other bare token is an unknown subcommand (`check rules` →
  // "`rules` is a command of its own"), never a silent full sweep at exit 0.
  positionals: PositionalMode.None,
  subverbs: [
    { name: 'boundaries', description: 'Enforce the layer / import boundary rules (alias-aware).', usage: BOUNDARIES_CHECK_USAGE },
    { name: 'wiring', description: 'The cross-file "declared but not wired" completeness gate (wiringRules[]).', usage: WIRING_CHECK_USAGE },
    {
      name: 'orphans',
      description: 'After a delete: surviving importers of the removed files / exports (alias-resolved).',
      usage: 'shrk check orphans [--since <ref>] [--staged] [--allow-empty] [--json]',
    },
    {
      name: 'imports',
      aliases: ['import-hygiene'],
      description: 'Import hygiene over the changed or selected files.',
      usage:
        'shrk check imports [--changed-only | --since <ref> | --staged | --files a,b] [--emit-allowlist [--emit-allowlist-kind <kind>]] [--only-allowlist-candidates] [--fail-on-unexplained-allowlist] [--allow-empty] [--json]',
    },
    {
      name: 'registry-lifecycle',
      description: 'Registry lifecycle symmetry across the tree (register ↔ unregister).',
      usage:
        'shrk check registry-lifecycle [--scope <glob>] [--changed-only | --since <ref>] [--limit N] [--offset N] [--budget-ms N] [--allow-empty] [--json]',
    },
    {
      name: 'generation',
      description: 'Dry-run one template generation and check its target paths.',
      usage: 'shrk check generation <templateId> <name> [--var k=v ...] [--changed-only | --since <ref> | --staged | --files a,b] [--json]',
      positionals: PositionalMode.Free,
    },
    { name: 'packs', description: 'Validate the installed packs.', usage: 'shrk check packs [--strict] [--min-score <0-100>] [--allow-empty] [--json]' },
    { name: 'pipelines', description: 'Validate the pipelines.', usage: 'shrk check pipelines [--strict] [--min-score <0-100>] [--allow-empty] [--json]' },
    { name: 'knowledge', description: 'Validate the knowledge entries.', usage: 'shrk check knowledge [--strict] [--min-score <0-100>] [--allow-empty] [--json]' },
    { name: 'templates', description: 'Validate the templates.', usage: 'shrk check templates [--strict] [--min-score <0-100>] [--allow-empty] [--json]' },
  ],
  description:
    'Run SharkCraft-level validation across knowledge / rules / templates / pipelines / packs / action hints / doctor. `check boundaries [--watch [--paths a,b] [--debounce N] [--once]]` re-runs the boundary scan on file changes.',
  usage:
    'shrk [--cwd <dir>] check [packs|pipelines|knowledge|templates|generation|boundaries|imports|wiring|orphans|registry-lifecycle] [--strict] [--min-score <0-100>] [--changed-only] [--since <ref>] [--staged] [--only <ids>] [--allow-empty] [--json] [--watch [--paths <list>] [--debounce N] [--once]]',
  // `--allow-empty` is the shared verdict valve (wiring / orphans / boundaries):
  // declared boolean so it can never swallow the positional subverb that
  // follows it. The boundary toggles (round 11) likewise never take a value.
  booleanFlags: new Set([ALLOW_EMPTY_FLAG, 'include-comments', 'fail-on-dead-units', 'no-rule-escalation']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    // `check generation <id> <name>` legitimately takes extra positionals;
    // every other subverb (boundaries/imports/wiring/…) and the full sweep are
    // flag-driven. Reject stray positional file args instead of silently
    // dropping them and reporting a confident green — pass files via --files.
    if (sub !== 'generation') {
      const extras = args.positional.slice(1);
      if (extras.length > 0) {
        process.stderr.write(
          `Unexpected positional argument(s): ${extras.join(', ')}. ` +
            `Use --files a.ts,b.ts (or --changed-only) instead of passing files positionally.\n`,
        );
        return 2;
      }
    }
    if (sub === 'generation') return checkGeneration(args);
    if (sub === 'boundaries') return checkBoundaries(args);
    if (sub === 'imports' || sub === 'import-hygiene') return checkImports(args);
    if (sub === 'wiring') return checkWiring(args);
    if (sub === 'orphans') return checkOrphans(args);
    // One body for both lifecycle verbs (registry-lifecycle-run.ts): engine-
    // owned coverage settled through the gate envelope — a capped / over-budget
    // / interrupted scan is 2 with the `--offset` that reaches the remainder.
    if (sub === 'registry-lifecycle') return runRegistryLifecycle(args, 'check registry-lifecycle');
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const readiness = buildAiReadinessReport(inspection);
    const readinessLine = `AI-readiness: ${readiness.score}/100 (${readiness.grade})`;
    // One group requested alone settles against that group's own doctor
    // coverage (`alone`): `check packs` over zero packs is 2, as `packs doctor`.
    if (sub === 'packs') {
      return renderReport(args, [await packsGroup(inspection, args)], readinessLine, true);
    }
    if (sub === 'pipelines') {
      return renderReport(args, [pipelinesGroup(inspection, args)], readinessLine, true);
    }
    if (sub === 'knowledge') {
      return renderReport(args, [knowledgeGroup(inspection, args)], readinessLine, true);
    }
    if (sub === 'templates') {
      return renderReport(args, [templatesGroup(inspection, args)], readinessLine, true);
    }
    // Default: full sweep.
    return renderReport(
      args,
      [
        doctorGroup(inspection),
        knowledgeGroup(inspection, args),
        templatesGroup(inspection, args),
        pipelinesGroup(inspection, args),
        await packsGroup(inspection, args),
        actionHintsGroup(inspection),
      ],
      readinessLine,
    );
  },
};
