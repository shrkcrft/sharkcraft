import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildNameVariables,
  describeInvalidPlannedOperation,
  generate,
  OverwriteStrategy,
  validatePlannedOperation,
} from '@shrkcrft/generator';
import {
  isTemplateRemainder,
  TEMPLATE_REMAINDERS,
  TemplateRemainder,
  type ITemplateDefinition,
} from '@shrkcrft/templates';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface ITemplateLintIssue {
  templateId: string;
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  suggestion?: string;
}

export interface ITemplateLintResult {
  templateId: string;
  issues: readonly ITemplateLintIssue[];
  passed: boolean;
}

export interface ITemplateLintReport {
  results: readonly ITemplateLintResult[];
  summary: { errors: number; warnings: number; info: number };
}

const PLACEHOLDER_RE = /\{\{\s*(\w+)\s*\}\}/g;

export function lintTemplates(
  inspection: ISharkcraftInspection,
  templateIds?: readonly string[],
): ITemplateLintReport {
  const all = inspection.templateRegistry.list();
  const targets = templateIds && templateIds.length > 0
    ? all.filter((t) => templateIds.includes(t.id))
    : all;
  const results: ITemplateLintResult[] = [];
  for (const t of targets) {
    const issues = [
      ...lintOne(t),
      ...lintOperations(t),
      ...lintRemainders(t, inspection.projectRoot),
    ];
    results.push({
      templateId: t.id,
      issues,
      passed: !issues.some((i) => i.severity === 'error'),
    });
  }
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const r of results) {
    for (const i of r.issues) {
      if (i.severity === 'error') summary.errors += 1;
      else if (i.severity === 'warning') summary.warnings += 1;
      else summary.info += 1;
    }
  }
  return { results, summary };
}

function lintOne(t: ITemplateDefinition): ITemplateLintIssue[] {
  const issues: ITemplateLintIssue[] = [];
  if (!t.name || t.name.trim().length === 0) {
    issues.push({ templateId: t.id, code: 'missing-name', severity: 'error', message: 'Template has no name' });
  }
  if (!t.description || t.description.trim().length === 0) {
    issues.push({ templateId: t.id, code: 'missing-description', severity: 'warning', message: 'Template has no description' });
  }
  const vars = t.variables ?? [];
  for (const v of vars) {
    if (!v.description) {
      issues.push({ templateId: t.id, code: 'undocumented-var', severity: 'info', message: `Variable "${v.name}" has no description` });
    }
    const hasExample = (v.examples ?? []).length > 0;
    if (v.required && !hasExample && !v.pattern) {
      issues.push({ templateId: t.id, code: 'required-var-no-example', severity: 'info', message: `Required variable "${v.name}" has no example or pattern` });
    }
  }
  const targetStr = typeof t.targetPath === 'string' ? t.targetPath : '';
  if (targetStr.length > 0) {
    if (targetStr.startsWith('/') || targetStr.includes('..')) {
      issues.push({ templateId: t.id, code: 'unsafe-target', severity: 'error', message: `targetPath escapes project root: ${targetStr}` });
    }
  }
  // Placeholder leak check: collect placeholders referenced in body+target.
  const referenced = new Set<string>();
  const body = typeof (t as { content?: unknown }).content === 'string' ? ((t as { content: string }).content) : '';
  for (const m of body.matchAll(PLACEHOLDER_RE)) referenced.add(m[1]!);
  for (const m of targetStr.matchAll(PLACEHOLDER_RE)) referenced.add(m[1]!);
  const known = new Set(vars.map((v) => v.name));
  // name/className/PascalCase/etc. are auto-filled.
  for (const auto of ['name', 'pascal', 'pascalCase', 'className', 'camel', 'camelCase', 'kebab', 'kebabCase', 'snake', 'snakeCase']) {
    known.add(auto);
  }
  for (const ref of referenced) {
    if (!known.has(ref)) {
      issues.push({ templateId: t.id, code: 'undeclared-var', severity: 'warning', message: `Placeholder {{${ref}}} is not declared in variables[]` });
    }
  }
  return issues;
}

/** The sample values lint renders a template's resolvers with (the same shape `testTemplates` uses, plus name variants). */
function sampleValues(t: ITemplateDefinition): Record<string, string> {
  const values: Record<string, string> = { ...buildNameVariables('sample') };
  for (const v of t.variables ?? []) {
    values[v.name] = v.examples?.[0] ?? (typeof v.default === 'string' ? v.default : undefined) ?? `sample-${v.name}`;
  }
  return values;
}

/**
 * `invalid-operation`: render `changes()` with sample variables and check every
 * op against the generator's own allow-list (`validatePlannedOperation` — the
 * table `planGeneration` checks). A misspelled op (`key`/`value` for
 * `entryKey`/`entryValue`) used to crash `gen` while lint said "clean".
 */
function lintOperations(t: ITemplateDefinition): ITemplateLintIssue[] {
  if (typeof t.changes !== 'function') return [];
  const issues: ITemplateLintIssue[] = [];
  let changes: unknown;
  try {
    changes = t.changes(sampleValues(t));
  } catch (e) {
    return [
      {
        templateId: t.id,
        code: 'render-threw',
        severity: 'warning',
        message: `changes() threw with sample variables — its operations were NOT checked: ${(e as Error).message}`,
      },
    ];
  }
  if (!Array.isArray(changes)) {
    return [
      { templateId: t.id, code: 'invalid-operation', severity: 'error', message: 'changes() must return an array of { targetPath, operation }' },
    ];
  }
  changes.forEach((c: unknown, i: number) => {
    const change = (c ?? {}) as { targetPath?: unknown; operation?: unknown };
    const where = `change[${i}]`;
    const shape = validatePlannedOperation(change.operation);
    const invalid =
      describeInvalidPlannedOperation(shape, where) ??
      (typeof change.targetPath !== 'string' || change.targetPath.length === 0
        ? `${where} (${shape.kind}): missing targetPath`
        : undefined);
    if (invalid) {
      issues.push({ templateId: t.id, code: 'invalid-operation', severity: 'error', message: invalid });
    } else if (shape.unknown.length > 0) {
      issues.push({
        templateId: t.id,
        code: 'operation-unknown-keys',
        severity: 'warning',
        message: `${where} (${shape.kind}): unknown key(s) ${shape.unknown.join(', ')} are ignored by the engine`,
      });
    }
  });
  return issues;
}

const BUILD_CONFIG_FILE =
  /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|project\.json|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj|pyproject\.toml)$/;

/**
 * `template-remainder-shape` (error): `notScaffolded` / `manualSteps` use only
 * the closed remainder vocabulary. `undeclared-remainder` (INFO only — a "new
 * module root" is inherently heuristic and must never fail a run): a CREATE
 * lands in a directory that does not exist yet, nothing rendered is build
 * config, and the template declares neither `notScaffolded: ['build-config']`
 * nor a manual step covering it.
 */
function lintRemainders(t: ITemplateDefinition, projectRoot: string): ITemplateLintIssue[] {
  const issues: ITemplateLintIssue[] = [];
  const allowed = TEMPLATE_REMAINDERS.join(', ');
  for (const v of (t.notScaffolded ?? []) as readonly unknown[]) {
    if (!isTemplateRemainder(v)) {
      issues.push({
        templateId: t.id,
        code: 'template-remainder-shape',
        severity: 'error',
        message: `notScaffolded: unknown remainder ${JSON.stringify(v)} (allowed: ${allowed})`,
      });
    }
  }
  (t.manualSteps ?? []).forEach((s, i) => {
    const step = (s ?? {}) as { description?: unknown; covers?: unknown };
    if (typeof step.description !== 'string' || step.description.trim().length === 0) {
      issues.push({
        templateId: t.id,
        code: 'template-remainder-shape',
        severity: 'error',
        message: `manualSteps[${i}].description must be a non-empty string`,
      });
    }
    for (const c of (Array.isArray(step.covers) ? step.covers : []) as readonly unknown[]) {
      if (!isTemplateRemainder(c)) {
        issues.push({
          templateId: t.id,
          code: 'template-remainder-shape',
          severity: 'error',
          message: `manualSteps[${i}].covers: unknown remainder ${JSON.stringify(c)} (allowed: ${allowed})`,
        });
      }
    }
  });

  const declaresBuildConfig =
    (t.notScaffolded ?? []).includes(TemplateRemainder.BuildConfig) ||
    (t.manualSteps ?? []).some((s) => (s.covers ?? []).includes(TemplateRemainder.BuildConfig));
  if (declaresBuildConfig) return issues;
  const values = sampleValues(t);
  const creates: string[] = [];
  try {
    if (typeof t.files === 'function') for (const f of t.files(values)) creates.push(f.targetPath);
  } catch {
    /* a throwing factory is testTemplates' finding */
  }
  try {
    if (typeof t.changes === 'function') {
      for (const c of t.changes(values)) if (c?.operation?.kind === 'create') creates.push(c.targetPath);
    }
  } catch {
    /* reported by lintOperations */
  }
  try {
    if (t.targetPath !== undefined && t.content !== undefined) {
      creates.push(typeof t.targetPath === 'function' ? t.targetPath(values) : t.targetPath);
    }
  } catch {
    /* ignore */
  }
  const normalized = creates.filter((p): p is string => typeof p === 'string').map((p) => p.split(nodePath.sep).join('/'));
  if (normalized.some((p) => BUILD_CONFIG_FILE.test(p))) return issues;
  const newRoot = normalized
    .map((p) => nodePath.dirname(p))
    .find((d) => d !== '.' && !existsSync(nodePath.resolve(projectRoot, d)));
  if (newRoot) {
    issues.push({
      templateId: t.id,
      code: 'undeclared-remainder',
      severity: 'info',
      message:
        `this template writes files under a new module root (${newRoot}) but declares neither build config nor a covering manual step`,
      suggestion: "Declare notScaffolded: ['build-config'] (or a manualSteps entry covering it), or emit the build config.",
    });
  }
  return issues;
}

export interface ITemplateTestResult {
  templateId: string;
  passed: boolean;
  renderedChanges: number;
  conflicts: number;
  errors: readonly string[];
}

export function testTemplates(
  inspection: ISharkcraftInspection,
  templateIds?: readonly string[],
): readonly ITemplateTestResult[] {
  const all = inspection.templateRegistry.list();
  const targets = templateIds && templateIds.length > 0
    ? all.filter((t) => templateIds.includes(t.id))
    : all;
  const results: ITemplateTestResult[] = [];
  for (const t of targets) {
    const vars = t.variables ?? [];
    const sampleVars: Record<string, string> = {};
    for (const v of vars) {
      sampleVars[v.name] = (v.examples?.[0]) ?? v.default ?? `sample-${v.name}`;
    }
    const r = generate(t, {
      templateId: t.id,
      name: 'sample',
      variables: sampleVars,
      projectRoot: inspection.projectRoot,
      overwriteStrategy: OverwriteStrategy.Never,
      write: false,
    });
    if (!r.ok) {
      results.push({
        templateId: t.id,
        passed: false,
        renderedChanges: 0,
        conflicts: 0,
        errors: [r.error.message],
      });
      continue;
    }
    const plan = r.value.plan;
    results.push({
      templateId: t.id,
      passed: plan.changes.length > 0 && !plan.hasConflicts,
      renderedChanges: plan.changes.length,
      conflicts: plan.changes.filter((c) => String(c.type) === 'conflict').length,
      errors: [],
    });
  }
  return results;
}
