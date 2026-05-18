import { generate, OverwriteStrategy } from '@shrkcrft/generator';
import type { ITemplateDefinition } from '@shrkcrft/templates';
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
    const issues = lintOne(t);
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
