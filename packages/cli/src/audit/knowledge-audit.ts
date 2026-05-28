import {
  buildKnowledgeStaleReport,
  KnowledgeLintCategory,
  KnowledgeLintSeverity,
  lintKnowledge,
  ReferenceCheckOutcome,
  type IKnowledgeLintFinding,
  type IKnowledgeReferenceCheck,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import type { IAiBlock } from '@shrkcrft/ai';

export type KnowledgeAuditFindingSeverity = 'info' | 'warn' | 'error';

export interface IKnowledgeAuditFinding {
  severity: KnowledgeAuditFindingSeverity;
  category: string;
  field: string;
  message: string;
  sources: readonly string[];
  stubSuggestion?: string;
  fixSuggestion?: string;
}

export interface ILlmKnowledgeAuditFinding {
  severity: KnowledgeAuditFindingSeverity;
  category: string;
  message: string;
  confidence: number;
}

export type KnowledgeAuditVerdict = 'ok' | 'minor' | 'stale' | 'broken';

export interface IKnowledgeAuditSuggestedAction {
  kind: 'edit' | 'rewrite' | 'retire' | 'investigate';
  target: string;
  note: string;
}

export interface IKnowledgeAuditEntry {
  entryId: string;
  entryType: string;
  title: string;
  verdict: KnowledgeAuditVerdict;
  deterministicFindings: readonly IKnowledgeAuditFinding[];
  llmFindings: readonly ILlmKnowledgeAuditFinding[];
  suggestedActions: readonly IKnowledgeAuditSuggestedAction[];
}

export interface IKnowledgeAuditSkipped {
  entryId: string;
  reason: string;
}

export interface IKnowledgeAuditReport {
  auditId: string;
  generatedAt: string;
  llmEnriched: boolean;
  llmProviderId: string | null;
  entries: readonly IKnowledgeAuditEntry[];
  skipped: readonly IKnowledgeAuditSkipped[];
  summary: {
    ok: number;
    minor: number;
    stale: number;
    broken: number;
    total: number;
  };
  ai?: IAiBlock;
}

export interface IBuildKnowledgeAuditOptions {
  /** Restrict to one entry id. */
  entryId?: string;
  /** Skip the stale-reference walk (slower; touches the filesystem). Defaults false. */
  skipStaleCheck?: boolean;
}

export function buildKnowledgeAudit(
  inspection: ISharkcraftInspection,
  options: IBuildKnowledgeAuditOptions = {},
): IKnowledgeAuditReport {
  const all = inspection.knowledgeEntries;
  // User-source only: skip pack-contributed entries (they're signed; not our place to audit).
  const userEntries = all.filter((e) => {
    const src = inspection.entrySources?.get(e.id);
    return !src || src.type === 'local';
  });
  const skipped: IKnowledgeAuditSkipped[] = all
    .filter((e) => !userEntries.includes(e))
    .map((e) => ({
      entryId: e.id,
      reason: 'pack-contributed (out of scope for v1 audit)',
    }));

  const targets = options.entryId
    ? userEntries.filter((e) => e.id === options.entryId)
    : userEntries;
  const targetIds = new Set(targets.map((t) => t.id));

  const lint = lintKnowledge(targets, {});
  const stale = options.skipStaleCheck ? null : safeBuildStaleReport(inspection);

  // Group lint findings by entryId.
  const lintByEntry = new Map<string, IKnowledgeLintFinding[]>();
  for (const f of lint.findings) {
    if (!targetIds.has(f.entryId)) continue;
    const list = lintByEntry.get(f.entryId) ?? [];
    list.push(f);
    lintByEntry.set(f.entryId, list);
  }
  // Group stale reference findings by entryId. Only stale/missing outcomes
  // (the deterministic engine already filters `ok`); promote to findings.
  const staleByEntry = new Map<string, IKnowledgeReferenceCheck[]>();
  for (const check of stale?.referenceChecks ?? []) {
    if (!targetIds.has(check.entryId)) continue;
    if (
      check.outcome === ReferenceCheckOutcome.Ok ||
      check.outcome === ReferenceCheckOutcome.Unknown
    ) {
      continue;
    }
    const list = staleByEntry.get(check.entryId) ?? [];
    list.push(check);
    staleByEntry.set(check.entryId, list);
  }

  const entries: IKnowledgeAuditEntry[] = [];
  for (const e of targets) {
    const lintFindings = lintByEntry.get(e.id) ?? [];
    const staleFindings = staleByEntry.get(e.id) ?? [];

    const raw: IKnowledgeAuditFinding[] = [];

    for (const f of lintFindings) {
      raw.push({
        severity: normaliseLintSeverity(f.severity),
        category: f.code,
        field: f.field,
        message: f.message,
        sources: ['knowledge lint'],
        ...(f.stubSuggestion ? { stubSuggestion: f.stubSuggestion } : {}),
      });
    }
    for (const f of staleFindings) {
      raw.push({
        severity: outcomeToSeverity(f.outcome),
        category: `knowledge-stale.${f.outcome}`,
        field: f.reference.kind ?? 'reference',
        message: f.message,
        sources: ['knowledge stale'],
        ...(f.suggestion ? { fixSuggestion: f.suggestion } : {}),
      });
    }

    const deterministicFindings = dedupeFindings(raw);
    entries.push({
      entryId: e.id,
      entryType: String(e.type),
      title: e.title ?? e.id,
      verdict: deriveVerdict(deterministicFindings),
      deterministicFindings,
      llmFindings: [],
      suggestedActions: deriveSuggestedActions(e.id, deterministicFindings),
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
    entries,
    skipped,
    summary,
  };
}

function safeBuildStaleReport(inspection: ISharkcraftInspection): ReturnType<typeof buildKnowledgeStaleReport> | null {
  try {
    return buildKnowledgeStaleReport(inspection);
  } catch {
    // The stale walker touches the filesystem; degrade to no-stale rather than
    // failing the audit when index access throws.
    return null;
  }
}

function normaliseLintSeverity(s: KnowledgeLintSeverity): KnowledgeAuditFindingSeverity {
  if (s === KnowledgeLintSeverity.Warning) return 'warn';
  return 'info';
}

function outcomeToSeverity(o: ReferenceCheckOutcome): KnowledgeAuditFindingSeverity {
  if (o === ReferenceCheckOutcome.Missing) return 'error';
  if (o === ReferenceCheckOutcome.Stale) return 'warn';
  return 'info';
}

function dedupeFindings(raw: readonly IKnowledgeAuditFinding[]): IKnowledgeAuditFinding[] {
  const byKey = new Map<string, IKnowledgeAuditFinding>();
  for (const f of raw) {
    const key = `${f.category}::${f.field}::${f.message}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f, sources: [...f.sources] });
      continue;
    }
    const sources = Array.from(new Set([...existing.sources, ...f.sources]));
    byKey.set(key, {
      ...existing,
      sources,
      severity: maxSeverity(existing.severity, f.severity),
    });
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const order: Record<KnowledgeAuditFindingSeverity, number> = { error: 0, warn: 1, info: 2 };
    return order[a.severity] - order[b.severity] || a.category.localeCompare(b.category);
  });
}

function maxSeverity(
  a: KnowledgeAuditFindingSeverity,
  b: KnowledgeAuditFindingSeverity,
): KnowledgeAuditFindingSeverity {
  const rank: Record<KnowledgeAuditFindingSeverity, number> = { info: 0, warn: 1, error: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function deriveVerdict(findings: readonly IKnowledgeAuditFinding[]): KnowledgeAuditVerdict {
  if (findings.some((f) => f.severity === 'error')) return 'broken';
  if (findings.some((f) => f.severity === 'warn')) return 'stale';
  if (findings.some((f) => f.severity === 'info')) return 'minor';
  return 'ok';
}

function deriveSuggestedActions(
  entryId: string,
  findings: readonly IKnowledgeAuditFinding[],
): IKnowledgeAuditSuggestedAction[] {
  const actions: IKnowledgeAuditSuggestedAction[] = [];
  const missingRef = findings.find((f) => f.category === `knowledge-stale.${ReferenceCheckOutcome.Missing}`);
  const staleRef = findings.find((f) => f.category === `knowledge-stale.${ReferenceCheckOutcome.Stale}`);
  const obsolete = findings.find((f) => f.category.includes('obsolete-entry'));
  const summaryMissing = findings.find((f) => f.category === 'knowledge.summary-missing');
  const hasError = findings.some((f) => f.severity === 'error');
  const hasWarn = findings.some((f) => f.severity === 'warn');

  if (missingRef) {
    actions.push({
      kind: 'edit',
      target: entryId,
      note: 'A referenced symbol/file no longer exists — update the reference or remove it.',
    });
  }
  if (staleRef) {
    actions.push({
      kind: 'edit',
      target: entryId,
      note: 'A referenced symbol moved or was renamed — update the reference to point at the new location.',
    });
  }
  if (obsolete) {
    actions.push({
      kind: 'retire',
      target: entryId,
      note: 'Entry classified as obsolete — confirm and remove, or refresh and re-tag.',
    });
  }
  if (summaryMissing) {
    actions.push({
      kind: 'edit',
      target: entryId,
      note: 'Add a one-sentence summary so consumers can grok the entry without opening it.',
    });
  }
  if (hasError && actions.length === 0) {
    actions.push({
      kind: 'investigate',
      target: entryId,
      note: 'Entry has error-level findings; review and fix before next consumption.',
    });
  }
  if (!hasError && hasWarn && actions.length === 0) {
    actions.push({
      kind: 'edit',
      target: entryId,
      note: 'Address warning-level findings to keep the entry aligned with current code.',
    });
  }
  return actions;
}
