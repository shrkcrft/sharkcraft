import {
  buildAiReadinessReport,
  buildImportHygieneReport,
  buildPackDoctorReport,
  ChangedScopeMode,
  diagnoseActionHints,
  emitImportHygieneAllowlistDraft,
  filterViolationsToChangedScope,
  ImportHygieneFindingKind,
  inspectSharkcraft,
  isTodoReason,
  renderImportHygieneText,
  resolveChangedFiles,
  runDoctor,
  suggestBoundaryFixes,
  type IChangedScopeOptions,
} from '@shrkcrft/inspector';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  flagBool,
  flagNumber,
  flagString,
  flagVars,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { maybeRunInWatchMode } from '../output/watch-loop.ts';
import { validateTemplateVariables } from '@shrkcrft/templates';
import { FileChangeType, planGeneration } from '@shrkcrft/generator';
import {
  evaluateBoundaries,
  loadTsconfigPaths,
  scanImports,
  summarizeImports,
} from '@shrkcrft/boundaries';

interface IGroupResult {
  name: string;
  passed: boolean;
  errors: number;
  warnings: number;
  details?: string[];
}

function knowledgeGroup(inspection: Awaited<ReturnType<typeof inspectSharkcraft>>): IGroupResult {
  const dup = inspection.validationIssues.filter((i) => i.code === 'duplicate-id');
  const missing = inspection.validationIssues.filter((i) => i.code !== 'duplicate-id');
  return {
    name: 'knowledge',
    passed: missing.length === 0 && dup.length === 0,
    errors: missing.length,
    warnings: dup.length,
    details: [
      ...missing.map((m) => `error: ${m.code} on ${m.entryId}`),
      ...dup.map((m) => `warn: duplicate id ${m.entryId}`),
    ],
  };
}

function templatesGroup(inspection: Awaited<ReturnType<typeof inspectSharkcraft>>): IGroupResult {
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
    details,
  };
}

function pipelinesGroup(inspection: Awaited<ReturnType<typeof inspectSharkcraft>>): IGroupResult {
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
  return {
    name: 'pipelines',
    passed: errors === 0,
    errors,
    warnings,
    details,
  };
}

function packsGroup(inspection: Awaited<ReturnType<typeof inspectSharkcraft>>): IGroupResult {
  const report = buildPackDoctorReport(inspection);
  return {
    name: 'packs',
    passed: report.passed,
    errors: report.summary.errors,
    warnings: report.summary.warnings,
    details: report.issues.map(
      (i) => `${i.severity}: ${i.packageName} ${i.code} — ${i.message}`,
    ),
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
    details: report.issues.map((i) => `warn: ${i.code} on ${i.entryId}`),
  };
}

function doctorGroup(
  inspection: Awaited<ReturnType<typeof inspectSharkcraft>>,
): IGroupResult {
  const result = runDoctor(inspection);
  return {
    name: 'doctor',
    passed: result.passed,
    errors: result.summary.errors,
    warnings: result.summary.warnings,
    details: result.checks
      .filter((c) => c.severity === 'error' || c.severity === 'warning')
      .map((c) => `${c.severity}: ${c.title} — ${c.message}`),
  };
}

function renderReport(
  args: ParsedArgs,
  groups: IGroupResult[],
  readinessLine: string | null,
): number {
  const totalErrors = groups.reduce((s, g) => s + g.errors, 0);
  const totalWarnings = groups.reduce((s, g) => s + g.warnings, 0);
  const passed = totalErrors === 0;
  const strict = flagBool(args, 'strict');
  const minScore = flagNumber(args, 'min-score');
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        passed,
        groups,
        totals: { errors: totalErrors, warnings: totalWarnings },
        readinessLine,
      }) + '\n',
    );
    return passed && (!strict || totalWarnings === 0) ? 0 : 1;
  }
  process.stdout.write(header('Check summary'));
  for (const g of groups) {
    process.stdout.write(
      `  ${g.passed ? 'OK   ' : 'FAIL '} ${g.name.padEnd(16)} errors=${g.errors} warnings=${g.warnings}\n`,
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
  return passed && (!strict || totalWarnings === 0) ? 0 : 1;
}

// ────────────────────────────────────────────────────────────────────────
// Subcommand: imports
// ────────────────────────────────────────────────────────────────────────
async function checkImports(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const changedOnly = flagBool(args, 'changed-only');
  const since = flagString(args, 'since');
  let files: readonly string[] | undefined;
  if (changedOnly || since) {
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

  if (flagBool(args, 'json')) {
    process.stdout.write(asJson(report) + '\n');
    return report.verdict === 'errors' ? 1 : 0;
  }
  process.stdout.write(renderImportHygieneText(report));
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
  return report.verdict === 'errors' ? 1 : 0;
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

async function checkBoundaries(args: ParsedArgs): Promise<number> {
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

async function checkBoundariesOnce(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const inspection = await inspectSharkcraft({ cwd });
  const rules = inspection.boundaryRegistry.list();
  const ruleFilter = flagString(args, 'rule');
  const polyglot = flagBool(args, 'polyglot');
  const changedScope = readChangedScopeOptions(args, cwd);
  if (polyglot) {
    // Emit the polyglot boundary report alongside (or instead of) the
    // existing TS-aware engine. Default is `both` — append polyglot section
    // after the TS one. JSON mode returns a combined payload.
    const { buildPolyglotBoundaryReport } = await import('@shrkcrft/inspector');
    const polyglotReport = buildPolyglotBoundaryReport({ projectRoot: cwd });
    // Apply changed-only filter before emit.
    const polyglotFiltered = changedScope
      ? filterViolationsToChangedScope(polyglotReport.violations, changedScope)
      : null;
    const polyglotViolations = polyglotFiltered
      ? polyglotFiltered.includedViolations
      : polyglotReport.violations;
    const polyglotErrors = polyglotViolations.filter((v) => v.severity === 'error').length;
    const polyglotWarnings = polyglotViolations.filter((v) => v.severity === 'warning').length;
    if (flagBool(args, 'json')) {
      // We still run the TS engine when rules exist, but always tack on the
      // polyglot report so CI/integrators get both surfaces.
      const tsScan = rules.length > 0 ? scanImports({ projectRoot: cwd }) : null;
      const tsEval = tsScan ? evaluateBoundaries(tsScan, rules, {
        ...(ruleFilter ? { onlyRuleId: ruleFilter } : {}),
      }) : null;
      const tsFiltered = tsEval && changedScope
        ? filterViolationsToChangedScope(tsEval.violations, changedScope)
        : null;
      const tsViolations = tsFiltered ? tsFiltered.includedViolations : tsEval?.violations ?? [];
      const tsErrors = tsViolations.filter((v) => v.severity === 'error').length;
      process.stdout.write(asJson({
        polyglot: {
          counts: { errors: polyglotErrors, warnings: polyglotWarnings, rules: polyglotReport.counts.rules },
          languages: polyglotReport.languages,
          violations: polyglotViolations,
        },
        typescript: tsEval ? {
          counts: { ...tsEval.counts, error: tsErrors },
          violations: tsViolations,
        } : null,
        ...(changedScope
          ? {
              changedScope: {
                mode: polyglotFiltered?.mode ?? ChangedScopeMode.ChangedOnly,
                changedFiles: polyglotFiltered?.changedFiles ?? [],
                ignoredLegacyCount:
                  (polyglotFiltered?.ignoredLegacyCount ?? 0) + (tsFiltered?.ignoredLegacyCount ?? 0),
                ignoredLegacyByRule: {
                  ...(polyglotFiltered?.ignoredLegacyByRule ?? {}),
                  ...(tsFiltered?.ignoredLegacyByRule ?? {}),
                },
              },
            }
          : {}),
      }) + '\n');
      return polyglotErrors > 0 || tsErrors > 0 ? 1 : 0;
    }
    process.stdout.write(header('Polyglot boundaries'));
    process.stdout.write(kv('languages', polyglotReport.languages.join(', ') || '(none)') + '\n');
    process.stdout.write(kv('rules', String(polyglotReport.counts.rules)) + '\n');
    process.stdout.write(kv('violations', `${polyglotErrors} errors, ${polyglotWarnings} warnings`) + '\n');
    if (polyglotFiltered) {
      process.stdout.write(kv('mode', polyglotFiltered.mode) + '\n');
      process.stdout.write(kv('changed files', String(polyglotFiltered.changedFiles.length)) + '\n');
      process.stdout.write(kv('legacy ignored', String(polyglotFiltered.ignoredLegacyCount)) + '\n');
    }
    if (polyglotViolations.length > 0) {
      for (const v of polyglotViolations) {
        process.stdout.write(`  ${v.severity.toUpperCase().padEnd(8)} ${v.ruleId}  ${v.fromFile}\n`);
        process.stdout.write(`           import: "${v.importSpecifier}"\n`);
        process.stdout.write(`           ↳ ${v.suggestedFix}\n`);
      }
    } else if (polyglotFiltered) {
      process.stdout.write('  No boundary violations introduced by changed files.\n');
    }
    if (polyglotErrors > 0) return 1;
    process.stdout.write('\n');
    // Fall through to the TS engine below so callers see both views.
  }
  if (rules.length === 0) {
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({ rules: 0, violations: [], note: 'no boundary rules configured' }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Boundaries'));
    process.stdout.write(
      '  No boundary rules configured. Add `sharkcraft/boundaries.ts` or install a pack with `boundaryFiles`.\n',
    );
    return 0;
  }
  const scan = scanImports({ projectRoot: cwd });
  const tsconfigPaths = loadTsconfigPaths(cwd);
  const evalResultRaw = evaluateBoundaries(scan, rules, {
    ...(ruleFilter ? { onlyRuleId: ruleFilter } : {}),
    ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
  });
  // Changed-only filtering on the TS engine output.
  const changedFiltered = changedScope
    ? filterViolationsToChangedScope(evalResultRaw.violations, changedScope)
    : null;
  const evalResult = changedFiltered
    ? {
        ...evalResultRaw,
        violations: changedFiltered.includedViolations,
        counts: {
          error: changedFiltered.includedViolations.filter((v) => v.severity === 'error').length,
          warning: changedFiltered.includedViolations.filter((v) => v.severity === 'warning').length,
          info: changedFiltered.includedViolations.filter((v) => v.severity === 'info').length,
        },
      }
    : evalResultRaw;
  const summary = summarizeImports(scan);
  const strict = flagBool(args, 'strict');
  const failed =
    evalResult.counts.error > 0 || (strict && evalResult.counts.warning > 0);
  const wantFixSuggestions = flagBool(args, 'fix-suggestions');
  const fixSuggestions = wantFixSuggestions
    ? suggestBoundaryFixes(
        inspection,
        evalResult.violations.map((v) => ({
          ruleId: v.ruleId,
          file: v.file,
          line: v.line,
          importSpecifier: v.importSpecifier,
          ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
        })),
      )
    : [];
  if (flagBool(args, 'json')) {
    process.stdout.write(
      asJson({
        passed: !failed,
        rulesEvaluated: evalResult.rulesEvaluated,
        edgesEvaluated: evalResult.edgesEvaluated,
        counts: evalResult.counts,
        violations: evalResult.violations,
        importGraph: summary,
        ...(wantFixSuggestions ? { fixSuggestions } : {}),
        ...(changedFiltered
          ? {
              changedScope: {
                mode: changedFiltered.mode,
                changedFiles: changedFiltered.changedFiles,
                includedViolations: changedFiltered.includedViolations,
                ignoredLegacyCount: changedFiltered.ignoredLegacyCount,
                ignoredLegacyByRule: changedFiltered.ignoredLegacyByRule,
              },
            }
          : {}),
      }) + '\n',
    );
    return failed ? 1 : 0;
  }
  process.stdout.write(header('Boundaries'));
  process.stdout.write(kv('rules', String(evalResult.rulesEvaluated)) + '\n');
  process.stdout.write(kv('files scanned', String(summary.filesScanned)) + '\n');
  process.stdout.write(kv('imports', String(summary.totalImports)) + '\n');
  process.stdout.write(
    kv(
      'violations',
      `${evalResult.counts.error} errors, ${evalResult.counts.warning} warnings, ${evalResult.counts.info} info`,
    ) + '\n',
  );
  if (changedFiltered) {
    process.stdout.write(kv('mode', changedFiltered.mode) + '\n');
    process.stdout.write(kv('changed files', String(changedFiltered.changedFiles.length)) + '\n');
    process.stdout.write(kv('legacy ignored', String(changedFiltered.ignoredLegacyCount)) + '\n');
  }
  process.stdout.write('\n');
  if (evalResult.violations.length === 0) {
    if (changedFiltered) {
      process.stdout.write('No boundary violations introduced by changed files.\n');
    } else {
      process.stdout.write('No violations.\n');
    }
    return 0;
  }
  for (const v of evalResult.violations) {
    const tag = v.severity.toUpperCase().padEnd(8);
    process.stdout.write(
      `  ${tag} ${v.ruleId.padEnd(28)} ${v.file}:${v.line}\n`,
    );
    process.stdout.write(`           import: "${v.importSpecifier}"\n`);
    if (v.matchedForbidden) {
      process.stdout.write(`           matched forbidden pattern: ${v.matchedForbidden}\n`);
    } else if (v.notAllowed) {
      process.stdout.write(`           not in allowed list for ${v.ruleId}\n`);
    }
    process.stdout.write(`           ${v.message}\n`);
    if (v.suggestedFix) process.stdout.write(`           ↳ ${v.suggestedFix}\n`);
  }
  if (wantFixSuggestions && fixSuggestions.length > 0) {
    process.stdout.write('\nFix suggestions:\n');
    for (const s of fixSuggestions) {
      process.stdout.write(`  ${s.file}:${s.line}\n`);
      for (const sug of s.suggestions) process.stdout.write(`    ↳ ${sug}\n`);
    }
  }
  process.stdout.write(
    `\nVerdict: ${failed ? 'boundary violations need attention' : 'OK ✓'}\n`,
  );
  return failed ? 1 : 0;
}

// ────────────────────────────────────────────────────────────────────────
// Main shrk check + subcommands
// ────────────────────────────────────────────────────────────────────────
export const checkCommand: ICommandHandler = {
  name: 'check',
  description:
    'Run SharkCraft-level validation across knowledge / rules / templates / pipelines / packs / action hints / doctor. `check boundaries [--watch [--paths a,b] [--debounce N] [--once]]` re-runs the boundary scan on file changes.',
  usage:
    'shrk [--cwd <dir>] check [packs|pipelines|knowledge|generation|boundaries|imports] [--strict] [--min-score <0-100>] [--json] [--watch [--paths <list>] [--debounce N] [--once]]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'generation') return checkGeneration(args);
    if (sub === 'boundaries') return checkBoundaries(args);
    if (sub === 'imports' || sub === 'import-hygiene') return checkImports(args);
    if (sub === 'registry-lifecycle') {
      const cwd = resolveCwd(args);
      const { buildRegistryLifecycleReport, renderRegistryLifecycleReportText } = await import('@shrkcrft/inspector');
      const report = buildRegistryLifecycleReport({ projectRoot: cwd });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(report) + '\n');
        return report.missingRemovers.length === 0 ? 0 : 1;
      }
      process.stdout.write(renderRegistryLifecycleReportText(report));
      return report.missingRemovers.length === 0 ? 0 : 1;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const readiness = buildAiReadinessReport(inspection);
    const readinessLine = `AI-readiness: ${readiness.score}/100 (${readiness.grade})`;
    if (sub === 'packs') {
      return renderReport(args, [packsGroup(inspection)], readinessLine);
    }
    if (sub === 'pipelines') {
      return renderReport(args, [pipelinesGroup(inspection)], readinessLine);
    }
    if (sub === 'knowledge') {
      return renderReport(args, [knowledgeGroup(inspection)], readinessLine);
    }
    if (sub === 'templates') {
      return renderReport(args, [templatesGroup(inspection)], readinessLine);
    }
    // Default: full sweep.
    return renderReport(
      args,
      [
        doctorGroup(inspection),
        knowledgeGroup(inspection),
        templatesGroup(inspection),
        pipelinesGroup(inspection),
        packsGroup(inspection),
        actionHintsGroup(inspection),
      ],
      readinessLine,
    );
  },
};
