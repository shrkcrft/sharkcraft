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
  resolveProjectConfig,
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
import { computeDeletedOrphans } from '../diff/deleted-orphans.ts';
import { renderWiringExplain } from './wiring.command.ts';
import { validateTemplateVariables } from '@shrkcrft/templates';
import { FileChangeType, planGeneration } from '@shrkcrft/generator';
import {
  evaluateBoundaries,
  explainWiring,
  loadTsconfigPaths,
  runWiring,
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
// ────────────────────────────────────────────────────────────────────────
// Subcommand: wiring — "declared but not wired" completeness checks
// ────────────────────────────────────────────────────────────────────────
async function checkWiring(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const changedOnly = flagBool(args, 'changed-only');
  const since = flagString(args, 'since');
  const only = flagString(args, 'only');

  // Distinguish "config is invalid" from "config valid with no wiring rules":
  // an invalid config (e.g. a malformed wiringRule) must NOT fail open with a
  // misleading "no rules configured" + exit 0.
  const loaded = await resolveProjectConfig(cwd);
  if (!loaded.ok) {
    const msg = loaded.error.message;
    if (wantJson) {
      process.stdout.write(
        asJson({ schema: 'sharkcraft.wiring/v1', error: msg, rules: [], violations: [], diagnostics: [msg], verdict: 'errors' }) + '\n',
      );
      return 1;
    }
    process.stdout.write(header('Wiring check'));
    process.stdout.write(`  ✗ Could not load config: ${msg}\n  Run \`shrk doctor\` for details.\n`);
    return 1;
  }
  const rules = loaded.value.config.wiringRules ?? [];
  const planeDiagnostics = loaded.value.planeDiagnostics;

  // `--explain <ruleId>`: dry-run ONE rule and print the declared + registered
  // sets it extracts (file:line), the set-difference, and the verdict — the
  // author-loop view of what the gate sees, without re-running the whole gate.
  if (args.flags.has('explain')) {
    const explainId = flagString(args, 'explain');
    if (!explainId) {
      process.stderr.write('Usage: shrk check wiring --explain <ruleId> [--json]\n');
      return 2;
    }
    const rule = rules.find((r) => r.id === explainId);
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
      return 2;
    }
    return renderWiringExplain(explainWiring(cwd, rule), wantJson);
  }

  if (rules.length === 0) {
    if (wantJson) {
      process.stdout.write(
        asJson({ schema: 'sharkcraft.wiring/v1', rules: [], violations: [], verdict: 'pass' }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Wiring check'));
    process.stdout.write(
      '  No wiring rules configured. Declare `wiringRules[]` in sharkcraft.config.ts to enable\n' +
        '  cross-file "declared but not wired" checks (see docs/wiring.md).\n',
    );
    return 0;
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
  const configured = rules.length;
  const selected = report.rules.length;
  const evaluated = report.evaluated;
  const skippedByScope = Math.max(0, configured - selected);
  const matchedNothing = Math.max(0, selected - evaluated);
  const notVerified = Math.max(0, configured - evaluated);
  const allEvaluated = evaluated === configured;
  const scopeNote = changedOnly || since ? ' by --changed-only' : '';
  const parts: string[] = [];
  if (skippedByScope > 0) parts.push(`${skippedByScope} skipped${scopeNote}`);
  if (matchedNothing > 0) parts.push(`${matchedNothing} matched no files`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';

  if (wantJson) {
    // Carry the honest counts so a machine consumer can tell "0 evaluated" from
    // a real green, and see how many rules the scope skipped.
    process.stdout.write(
      asJson({ ...report, configured, selected, evaluated, skippedByScope, matchedNothing, notVerified }) + '\n',
    );
    return report.verdict === 'errors' ? 1 : 0;
  }

  process.stdout.write(header('Wiring check'));
  // `evaluated` counts rules that actually ran a comparison (globs matched >0
  // files). When 0 rules evaluated but rules ARE configured, say so loudly —
  // "checked nothing" must never read as the green "every token is wired" pass.
  if (evaluated === 0) {
    process.stdout.write(
      `  ! 0 rules evaluated — NOT verified. ${configured} rule(s) configured${breakdown}; ` +
        'none ran a comparison in scope. Wiring was not checked — this is not a pass.\n',
    );
    return 0;
  }
  process.stdout.write(kv('rules evaluated', `${evaluated} of ${configured}${breakdown}`) + '\n');
  const errors = report.violations.filter((v) => v.severity === 'error').length;
  const warnings = report.violations.filter((v) => v.severity === 'warning').length;
  process.stdout.write(kv('violations', `${errors} error(s), ${warnings} warning(s)`) + '\n');
  // Misconfigured rules (uncompilable pattern / no capture group) — surface
  // them loudly; a broken rule must never read as a silent green.
  if (report.diagnostics.length > 0) {
    process.stdout.write('\nMisconfigured rules:\n');
    for (const d of report.diagnostics) process.stdout.write(`  ! ${d}\n`);
  }
  if (report.violations.length === 0 && report.diagnostics.length === 0) {
    if (allEvaluated) {
      // Every configured rule ran — the earned full green.
      process.stdout.write('\nNo wiring violations — every declared token is registered. ✓\n');
    } else {
      // A subset ran: no violations AMONG WHAT RAN, but not a full green. Never
      // print the unqualified "every declared token is wired" success sentence.
      process.stdout.write(
        `\nNo wiring violations among the ${evaluated} rule(s) evaluated — ` +
          `${notVerified} of ${configured} NOT verified${breakdown}. Not a full green.\n`,
      );
    }
    return 0;
  }
  if (report.violations.length === 0) {
    return report.verdict === 'errors' ? 1 : 0;
  }
  // Group by rule for a readable report.
  for (const r of report.rules) {
    if (r.violations.length === 0) continue;
    process.stdout.write(`\n[${r.severity}] ${r.ruleId}${r.description ? ' — ' + r.description : ''}\n`);
    process.stdout.write(
      `  declared ${r.declaredCount} / registered ${r.registeredCount} — ${r.violations.length} not wired:\n`,
    );
    for (const v of r.violations.slice(0, 50)) {
      process.stdout.write(`    • ${v.token}  (${v.file}:${v.line})\n`);
    }
    if (r.violations.length > 50) {
      process.stdout.write(`    … (${r.violations.length - 50} more)\n`);
    }
    const hint = r.violations.find((v) => v.hint)?.hint;
    if (hint) process.stdout.write(`    → ${hint}\n`);
  }
  return report.verdict === 'errors' ? 1 : 0;
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

  // Nothing deleted → there is nothing to check. Report a LOUD skip, not a
  // green "no orphans" — "checked nothing" must never read as "verified clean".
  if (scan.deleted.length === 0) {
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
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(header('Orphan check'));
    process.stdout.write(`  ! Nothing deleted (${scopeLabel}) — orphan check skipped.\n`);
    return 0;
  }

  const report = scan.report!;
  if (wantJson) {
    process.stdout.write(asJson(report) + '\n');
    return report.orphans.length > 0 ? 1 : 0;
  }

  process.stdout.write(header('Orphan check'));
  process.stdout.write(kv('deleted files', `${scan.deleted.length} (${scopeLabel})`) + '\n');
  if (report.orphans.length === 0) {
    process.stdout.write('\nNo orphaned importers — nothing still references the deleted code. ✓\n');
    for (const d of report.diagnostics.slice(0, 5)) process.stdout.write(`  ! ${d}\n`);
    return 0;
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
  return 1;
}

// Main shrk check + subcommands
// ────────────────────────────────────────────────────────────────────────
export const checkCommand: ICommandHandler = {
  name: 'check',
  description:
    'Run SharkCraft-level validation across knowledge / rules / templates / pipelines / packs / action hints / doctor. `check boundaries [--watch [--paths a,b] [--debounce N] [--once]]` re-runs the boundary scan on file changes.',
  usage:
    'shrk [--cwd <dir>] check [packs|pipelines|knowledge|generation|boundaries|imports|wiring|orphans] [--strict] [--min-score <0-100>] [--changed-only] [--since <ref>] [--staged] [--only <ids>] [--json] [--watch [--paths <list>] [--debounce N] [--once]]',
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
    if (sub === 'registry-lifecycle') {
      const cwd = resolveCwd(args);
      const changedOnly = flagBool(args, 'changed-only');
      const since = flagString(args, 'since');
      const scope = flagString(args, 'scope');
      const { buildRegistryLifecycleReport, renderRegistryLifecycleReportText } = await import('@shrkcrft/inspector');
      // `--changed-only` scopes the scan to the diff (tracked + untracked), so it
      // runs inline in seconds; the full-tree scan is bounded by a wall-clock
      // budget and flushes partial results on timeout instead of hanging.
      let files: readonly string[] | undefined;
      if (changedOnly || since) {
        const changed = resolveChangedFiles({
          projectRoot: cwd,
          ...(since ? { since } : {}),
          ...(changedOnly && !since ? { includeWorktree: true } : {}),
        });
        files = changed.files;
      }
      // Full-tree walk honors the project's skipDirs override (so a repo that
      // registers code under tools/ etc. isn't blinded by the default set).
      let skipDirs: readonly string[] | undefined;
      if (files === undefined) {
        const loaded = await resolveProjectConfig(cwd);
        if (loaded.ok) skipDirs = loaded.value.config.registryLifecycle?.skipDirs;
      }
      // Only the slow full-tree path needs the heartbeat (JSON keeps stdout clean).
      if (!flagBool(args, 'json') && files === undefined) {
        process.stderr.write('⏳ Scanning source + registries for lifecycle coverage (bounded by a wall-clock budget)…\n');
      }
      const report = buildRegistryLifecycleReport({
        projectRoot: cwd,
        ...(files !== undefined ? { files } : {}),
        ...(scope ? { scope } : {}),
        ...(skipDirs ? { skipDirs } : {}),
      });
      // Deterministic non-zero on timeout so a wedged scan fails loud, not silent.
      const exit = report.timedOut ? 2 : report.missingRemovers.length === 0 ? 0 : 1;
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(report) + '\n');
        return exit;
      }
      process.stdout.write(renderRegistryLifecycleReportText(report));
      return exit;
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
