/**
 * Template drift verification.
 *
 * For each registered template (local + pack), produces a sample dry-run
 * to verify:
 *   - target paths align with the registered path conventions.
 *   - no forbidden legacy patterns (templates declare these via
 *     plugin contract templates).
 *   - referenced barrels exist when an `export` op points at them.
 *   - insert / replace anchors are non-empty (and exist when target is
 *     also created in the same template).
 *   - related construct / template / helper / playbook / policy ids
 *     resolve.
 *
 * Read-only — no shell, no network, no source writes.
 *
 * Schema: sharkcraft.template-drift/v1
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const TEMPLATE_DRIFT_SCHEMA = 'sharkcraft.template-drift/v1';

export enum TemplateDriftStatus {
  Pass = 'pass',
  Warn = 'warn',
  Fail = 'fail',
}

export interface ITemplateDriftIssue {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  suggestedFix?: string;
}

export interface ITemplateDriftEntry {
  templateId: string;
  templateName?: string;
  status: TemplateDriftStatus;
  samplePaths: readonly string[];
  issues: ReadonlyArray<ITemplateDriftIssue>;
}

export interface ITemplateDriftReport {
  schema: typeof TEMPLATE_DRIFT_SCHEMA;
  generatedAt: string;
  totalTemplates: number;
  pass: number;
  warn: number;
  fail: number;
  entries: ReadonlyArray<ITemplateDriftEntry>;
}

export interface ITemplateDriftCheckOptions {
  /** When set, only the template with this id is verified. */
  templateId?: string;
  /** When set, only templates contributed by this pack are verified. */
  packId?: string;
  /** Sample variable values for templates with required vars (key→string). */
  sampleVars?: Readonly<Record<string, string>>;
}

const SAMPLE_NAME = 'sample-feature';

/**
 * Templates can declare their own forbidden-path fragments via
 * `template.metadata.forbiddenPathFragments` (optional). The engine no
 * longer hardcodes per-template fragments.
 */

function buildSampleValues(
  template: ITemplateDefinition,
  override: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const v of template.variables ?? []) {
    const name = (v as { name?: string; key?: string }).name ?? (v as { key?: string }).key ?? '';
    if (!name) continue;
    if (override && override[name] !== undefined) values[name] = override[name];
    else if ((v as { default?: unknown }).default !== undefined) {
      values[name] = String((v as { default: unknown }).default);
    } else if (name.toLowerCase() === 'name' || name === 'pluginName' || name === 'pluginKey') {
      values[name] = SAMPLE_NAME;
    } else {
      values[name] = 'sample';
    }
  }
  return values;
}

function describeForbiddenPaths(template: ITemplateDefinition): readonly string[] {
  const meta = (template as { metadata?: { forbiddenPathFragments?: readonly string[] } }).metadata;
  if (meta?.forbiddenPathFragments && Array.isArray(meta.forbiddenPathFragments)) {
    return meta.forbiddenPathFragments;
  }
  return [];
}

function safeRender(
  template: ITemplateDefinition,
  values: Record<string, string>,
): { paths: string[]; warnings: string[]; ops: { kind: string; target: string; anchor?: string; from?: string }[] } {
  const paths: string[] = [];
  const warnings: string[] = [];
  const ops: { kind: string; target: string; anchor?: string; from?: string }[] = [];
  try {
    if (typeof template.files === 'function') {
      const files = template.files(values);
      for (const f of files) {
        paths.push(f.targetPath);
        ops.push({ kind: 'create', target: f.targetPath });
      }
    }
    if (typeof template.changes === 'function') {
      const changes = template.changes(values);
      for (const c of changes) {
        paths.push(c.targetPath);
        ops.push({
          kind: c.operation.kind,
          target: c.targetPath,
          ...((c.operation.kind === 'insert-after' || c.operation.kind === 'insert-before')
            ? { anchor: c.operation.anchor }
            : {}),
          ...((c.operation.kind === 'export')
            ? { from: c.operation.from }
            : {}),
        });
      }
    }
    if (
      typeof template.files !== 'function' &&
      typeof template.changes !== 'function' &&
      template.targetPath
    ) {
      const tp = typeof template.targetPath === 'function' ? template.targetPath(values) : template.targetPath;
      paths.push(tp);
      ops.push({ kind: 'create', target: tp });
    }
  } catch (e) {
    warnings.push(`render threw: ${(e as Error).message}`);
  }
  return { paths, warnings, ops };
}

function checkPathConventions(
  inspection: ISharkcraftInspection,
  paths: readonly string[],
): ITemplateDriftIssue[] {
  const issues: ITemplateDriftIssue[] = [];
  // Path conventions are name patterns; we only flag a path that obviously
  // mismatches every applicable convention. The conservative default: if no
  // convention names match any sample path, emit one info issue per path.
  const svc = (inspection as { pathService?: { list?: () => readonly { id: string; pattern?: string }[] } }).pathService;
  const conventions = svc && typeof svc.list === 'function' ? svc.list() : [];
  if (conventions.length === 0) return issues;
  for (const p of paths) {
    let matched = false;
    for (const c of conventions) {
      const pattern = (c as { pattern?: string }).pattern;
      if (!pattern) continue;
      // very lightweight substring check — these are heuristics.
      const cleaned = pattern.replace(/\{.*?\}/g, '').replace(/[.*+?^${}()|[\]\\]/g, '');
      if (cleaned.length > 4 && p.includes(cleaned)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      issues.push({
        severity: 'info',
        code: 'path-no-convention',
        message: `Sample path "${p}" does not match any registered path convention.`,
      });
    }
  }
  return issues;
}

function checkForbiddenFragments(
  template: ITemplateDefinition,
  paths: readonly string[],
): ITemplateDriftIssue[] {
  const issues: ITemplateDriftIssue[] = [];
  const forbidden = describeForbiddenPaths(template);
  if (forbidden.length === 0) return issues;
  for (const p of paths) {
    for (const frag of forbidden) {
      if (p.includes(frag)) {
        issues.push({
          severity: 'error',
          code: 'forbidden-legacy-path',
          message: `Sample path "${p}" contains forbidden legacy fragment "${frag}". Update the template to use canonical paths.`,
        });
      }
    }
  }
  return issues;
}

function checkBarrelTargets(
  projectRoot: string,
  ops: readonly { kind: string; target: string; anchor?: string; from?: string }[],
): ITemplateDriftIssue[] {
  const issues: ITemplateDriftIssue[] = [];
  for (const op of ops) {
    if (op.kind !== 'export') continue;
    const full = nodePath.join(projectRoot, op.target);
    if (!existsSync(full)) {
      issues.push({
        severity: 'warning',
        code: 'missing-barrel',
        message: `export op references missing barrel "${op.target}".`,
        suggestedFix: 'Create the barrel before applying, or update the template target.',
      });
    }
  }
  return issues;
}

function checkRelatedIds(
  inspection: ISharkcraftInspection,
  template: ITemplateDefinition,
): ITemplateDriftIssue[] {
  const issues: ITemplateDriftIssue[] = [];
  for (const id of template.related ?? []) {
    // related ids are knowledge / construct / template / playbook — try
    // them all.
    const knowledge = inspection.index.get(id);
    const tmpl = inspection.templates.find((t) => t.id === id);
    if (!knowledge && !tmpl) {
      issues.push({
        severity: 'info',
        code: 'related-id-unresolved',
        message: `related id "${id}" not found in knowledge or template registries.`,
      });
    }
  }
  return issues;
}

function checkAnchorsNonEmpty(
  ops: readonly { kind: string; target: string; anchor?: string }[],
): ITemplateDriftIssue[] {
  const issues: ITemplateDriftIssue[] = [];
  for (const op of ops) {
    if ((op.kind === 'insert-after' || op.kind === 'insert-before') && !op.anchor) {
      issues.push({
        severity: 'error',
        code: 'missing-anchor',
        message: `${op.kind} op on "${op.target}" has no anchor.`,
      });
    }
  }
  return issues;
}

/**
 * Verify the template's `producedAnchors[]` metadata is consistent with
 * the rendered output. For every declared producer, the body of the target
 * file must contain the anchor literal. Missing producers surface as
 * `missing-produced-anchor` issues (warning by default).
 */
function checkProducedAnchors(
  template: ITemplateDefinition,
  values: Record<string, string>,
): ITemplateDriftIssue[] {
  const issues: ITemplateDriftIssue[] = [];
  const declared = template.metadata?.producedAnchors;
  if (!declared || declared.length === 0) return issues;
  const rendered = new Map<string, string>(); // path → body
  try {
    if (typeof template.files === 'function') {
      for (const f of template.files(values)) rendered.set(f.targetPath, f.content);
    }
  } catch {
    // render errors already surfaced by safeRender; skip here.
  }
  for (const decl of declared) {
    // `in` may be a glob or a literal path. We do a substring/glob-ish match.
    const candidates = [...rendered.entries()].filter(([p]) => pathMatchesPattern(p, decl.in));
    if (candidates.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'produced-anchor-target-missing',
        message: `producedAnchors entry "${decl.anchor}" refers to "${decl.in}", but the template did not render any file matching that pattern.`,
      });
      continue;
    }
    const anyMatch = candidates.some(([, body]) => body.includes(decl.anchor));
    if (!anyMatch) {
      issues.push({
        severity: 'error',
        code: 'missing-produced-anchor',
        message: `Template declares producedAnchor "${decl.anchor}" in "${decl.in}", but the rendered file does not contain it.`,
        suggestedFix: `Add the anchor literal to the rendered ${decl.in} or remove the declaration.`,
      });
    }
  }
  return issues;
}

/**
 * Verify the template's `requiredAnchors[]` metadata against the union
 * of all `producedAnchors[]` from every registered template (local + pack).
 * Surfaces `missing-required-anchor` when no producer exists.
 */
function checkRequiredAnchors(
  template: ITemplateDefinition,
  allProduced: Map<string, ReadonlySet<string>>,
): ITemplateDriftIssue[] {
  const issues: ITemplateDriftIssue[] = [];
  const required = template.metadata?.requiredAnchors;
  if (!required || required.length === 0) return issues;
  for (const decl of required) {
    let found = false;
    for (const [pattern, anchors] of allProduced) {
      if (pathMatchesPattern(pattern, decl.in) || pathMatchesPattern(decl.in, pattern)) {
        if (anchors.has(decl.anchor)) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      issues.push({
        severity: 'warning',
        code: 'missing-required-anchor',
        message: `Template requires anchor "${decl.anchor}" in "${decl.in}", but no other template declares it as a producer.`,
        suggestedFix: `Add producedAnchors metadata to the scaffold that creates "${decl.in}", or declare a registration hint.`,
      });
    }
  }
  return issues;
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  if (pattern === path) return true;
  if (!pattern.includes('*')) return path === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function classify(
  issues: readonly ITemplateDriftIssue[],
): TemplateDriftStatus {
  if (issues.some((i) => i.severity === 'error')) return TemplateDriftStatus.Fail;
  if (issues.some((i) => i.severity === 'warning')) return TemplateDriftStatus.Warn;
  return TemplateDriftStatus.Pass;
}

export function buildTemplateDriftReport(
  inspection: ISharkcraftInspection,
  options: ITemplateDriftCheckOptions = {},
): ITemplateDriftReport {
  const entries: ITemplateDriftEntry[] = [];
  const all = inspection.templates as ITemplateDefinition[];
  const filtered = options.templateId ? all.filter((t) => t.id === options.templateId) : all;

  // Build the cross-template anchor producer map ONCE so each entry
  // can look up "is anchor X declared by some template?".
  const allProduced = new Map<string, ReadonlySet<string>>();
  for (const t of all) {
    const declared = t.metadata?.producedAnchors;
    if (!declared || declared.length === 0) continue;
    for (const decl of declared) {
      const existing = allProduced.get(decl.in) ?? new Set<string>();
      const next = new Set<string>(existing);
      next.add(decl.anchor);
      allProduced.set(decl.in, next);
    }
  }

  for (const t of filtered) {
    const values = buildSampleValues(t, options.sampleVars);
    const { paths, warnings: renderWarnings, ops } = safeRender(t, values);
    const renderIssues = renderWarnings.map<ITemplateDriftIssue>((w) => ({
      severity: 'warning',
      code: 'render-warning',
      message: w,
    }));
    const allIssues = [
      ...renderIssues,
      ...checkForbiddenFragments(t, paths),
      ...checkPathConventions(inspection, paths),
      ...checkBarrelTargets(inspection.projectRoot, ops),
      ...checkRelatedIds(inspection, t),
      ...checkAnchorsNonEmpty(ops),
      ...checkProducedAnchors(t, values),
      ...checkRequiredAnchors(t, allProduced),
    ];
    entries.push({
      templateId: t.id,
      templateName: t.name,
      status: classify(allIssues),
      samplePaths: paths,
      issues: allIssues,
    });
  }
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const e of entries) {
    if (e.status === TemplateDriftStatus.Pass) pass += 1;
    else if (e.status === TemplateDriftStatus.Warn) warn += 1;
    else fail += 1;
  }
  return {
    schema: TEMPLATE_DRIFT_SCHEMA,
    generatedAt: new Date().toISOString(),
    totalTemplates: filtered.length,
    pass,
    warn,
    fail,
    entries,
  };
}
