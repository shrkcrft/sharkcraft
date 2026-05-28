import {
  buildTemplateDriftReport,
  lintTemplates,
  TemplateDriftStatus,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import type { IAiBlock } from '@shrkcrft/ai';

export type AuditFindingSeverity = 'info' | 'warn' | 'error';

export interface IAuditFinding {
  severity: AuditFindingSeverity;
  category: string;
  message: string;
  location?: string;
  sources: readonly string[];
  suggestion?: string;
}

export interface ILlmAuditFinding {
  severity: AuditFindingSeverity;
  category: string;
  message: string;
  confidence: number;
}

export type AuditVerdict = 'ok' | 'minor' | 'stale' | 'broken';

export interface IAuditSuggestedAction {
  kind: 'edit' | 'regenerate' | 'retire' | 'investigate';
  target: string;
  note: string;
}

export interface ITemplateAuditEntry {
  templateId: string;
  templateName: string;
  verdict: AuditVerdict;
  usage: 'unknown';
  deterministicFindings: readonly IAuditFinding[];
  llmFindings: readonly ILlmAuditFinding[];
  suggestedActions: readonly IAuditSuggestedAction[];
}

export interface IAuditSkipped {
  templateId: string;
  reason: string;
}

export interface ITemplateAuditReport {
  auditId: string;
  generatedAt: string;
  llmEnriched: boolean;
  llmProviderId: string | null;
  templates: readonly ITemplateAuditEntry[];
  skipped: readonly IAuditSkipped[];
  summary: {
    ok: number;
    minor: number;
    stale: number;
    broken: number;
    total: number;
  };
  /**
   * Configuration-state block populated by the command handler before
   * the report is emitted. Always present — without LLM the block
   * carries setup hints; with LLM it carries upgrade hints. Lets
   * Claude self-configure shrk without external prompting.
   */
  ai?: IAiBlock;
}

export interface IBuildAuditOptions {
  templateId?: string;
}

export function buildTemplateAudit(
  inspection: ISharkcraftInspection,
  options: IBuildAuditOptions = {},
): ITemplateAuditReport {
  const all = inspection.templateRegistry.list();
  const userTemplates = all.filter(
    (t) => (inspection.templateSources.get(t.id)?.type ?? 'local') === 'local',
  );
  const skipped: IAuditSkipped[] = all
    .filter((t) => !userTemplates.includes(t))
    .map((t) => ({
      templateId: t.id,
      reason: 'pack-contributed (out of scope for v1 audit)',
    }));

  const targets = options.templateId
    ? userTemplates.filter((t) => t.id === options.templateId)
    : userTemplates;

  const lint = lintTemplates(
    inspection,
    targets.map((t) => t.id),
  );
  const drift = buildTemplateDriftReport(
    inspection,
    options.templateId ? { templateId: options.templateId } : {},
  );

  const lintByTemplate = new Map<string, (typeof lint.results)[number]>();
  for (const r of lint.results) lintByTemplate.set(r.templateId, r);

  const driftByTemplate = new Map<string, (typeof drift.entries)[number]>();
  for (const e of drift.entries) driftByTemplate.set(e.templateId, e);

  const entries: ITemplateAuditEntry[] = [];
  for (const t of targets) {
    const lintEntry = lintByTemplate.get(t.id);
    const driftEntry = driftByTemplate.get(t.id);

    const raw: IAuditFinding[] = [];

    for (const i of lintEntry?.issues ?? []) {
      raw.push({
        severity: normaliseSeverity(i.severity),
        category: i.code,
        message: i.message,
        sources: ['templates lint'],
        ...(i.suggestion ? { suggestion: i.suggestion } : {}),
      });
    }
    for (const i of driftEntry?.issues ?? []) {
      raw.push({
        severity: normaliseSeverity(i.severity),
        category: i.code,
        message: i.message,
        sources: ['templates drift'],
        ...(i.suggestedFix ? { suggestion: i.suggestedFix } : {}),
      });
    }

    const deterministicFindings = dedupeFindings(raw);

    entries.push({
      templateId: t.id,
      templateName: t.name,
      verdict: deriveVerdict(deterministicFindings, driftEntry?.status ?? null),
      usage: 'unknown',
      deterministicFindings,
      llmFindings: [],
      suggestedActions: deriveSuggestedActions(t.id, deterministicFindings),
    });
  }

  const summary = entries.reduce(
    (acc, e) => {
      acc[e.verdict] += 1;
      acc.total += 1;
      return acc;
    },
    { ok: 0, minor: 0, stale: 0, broken: 0, total: 0 },
  );

  const generatedAt = new Date().toISOString();
  return {
    auditId: `audit-${generatedAt.replace(/[:.]/g, '-')}`,
    generatedAt,
    llmEnriched: false,
    llmProviderId: null,
    templates: entries,
    skipped,
    summary,
  };
}

function normaliseSeverity(s: 'error' | 'warning' | 'info'): AuditFindingSeverity {
  if (s === 'error') return 'error';
  if (s === 'warning') return 'warn';
  return 'info';
}

function dedupeFindings(raw: readonly IAuditFinding[]): IAuditFinding[] {
  const byKey = new Map<string, IAuditFinding>();
  for (const f of raw) {
    const key = `${f.category}::${f.message}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f, sources: [...f.sources] });
      continue;
    }
    const mergedSources = Array.from(new Set([...existing.sources, ...f.sources]));
    byKey.set(key, {
      ...existing,
      sources: mergedSources,
      ...(existing.suggestion || f.suggestion
        ? { suggestion: existing.suggestion ?? f.suggestion }
        : {}),
      severity: maxSeverity(existing.severity, f.severity),
    });
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const order: Record<AuditFindingSeverity, number> = { error: 0, warn: 1, info: 2 };
    return order[a.severity] - order[b.severity] || a.category.localeCompare(b.category);
  });
}

function maxSeverity(a: AuditFindingSeverity, b: AuditFindingSeverity): AuditFindingSeverity {
  const rank: Record<AuditFindingSeverity, number> = { info: 0, warn: 1, error: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function deriveVerdict(
  findings: readonly IAuditFinding[],
  driftStatus: TemplateDriftStatus | null,
): AuditVerdict {
  if (findings.some((f) => f.severity === 'error')) return 'broken';
  if (driftStatus === TemplateDriftStatus.Fail) return 'broken';
  if (findings.some((f) => f.severity === 'warn')) return 'stale';
  if (driftStatus === TemplateDriftStatus.Warn) return 'stale';
  if (findings.some((f) => f.severity === 'info')) return 'minor';
  return 'ok';
}

function deriveSuggestedActions(
  templateId: string,
  findings: readonly IAuditFinding[],
): IAuditSuggestedAction[] {
  const actions: IAuditSuggestedAction[] = [];
  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warn');
  const undeclared = findings.find((f) => f.category === 'undeclared-var');
  const unsafe = findings.find((f) => f.category === 'unsafe-target');
  const noConvention = findings.find((f) => f.category === 'path-no-convention');
  const missingName = findings.find((f) => f.category === 'missing-name');

  if (unsafe) {
    actions.push({
      kind: 'edit',
      target: templateId,
      note: 'targetPath escapes project root — rewrite to a safe relative path under packages/.',
    });
  }
  if (missingName) {
    actions.push({
      kind: 'edit',
      target: templateId,
      note: 'Template has no name — add a human-readable `name` field.',
    });
  }
  if (undeclared) {
    actions.push({
      kind: 'edit',
      target: templateId,
      note: 'Placeholder is not declared in variables[] — declare it or remove the reference.',
    });
  }
  if (noConvention) {
    actions.push({
      kind: 'investigate',
      target: templateId,
      note: 'Sample path does not match any registered path convention — confirm the targetPath fn aligns with paths.ts.',
    });
  }
  if (hasError && actions.length === 0) {
    actions.push({
      kind: 'investigate',
      target: templateId,
      note: 'Template has error-level findings; review and fix before next generation.',
    });
  }
  if (!hasError && hasWarn && actions.length === 0) {
    actions.push({
      kind: 'edit',
      target: templateId,
      note: 'Address warning-level findings to keep the template aligned with current conventions.',
    });
  }
  return actions;
}
