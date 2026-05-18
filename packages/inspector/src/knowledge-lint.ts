/**
 * Knowledge lint + fix-preview.
 *
 * Pure inspector — classifies findings on the current knowledge entries.
 * Never fills meaningful prose with fake content. Stub candidates use
 * explicit TODO markers so a human / agent must finish the wording.
 *
 * Output schemas:
 *   - sharkcraft.knowledge-lint/v1
 *   - sharkcraft.knowledge-lint-fix-preview/v1
 */

import type { IKnowledgeEntry } from '@shrkcrft/knowledge';

export const KNOWLEDGE_LINT_SCHEMA = 'sharkcraft.knowledge-lint/v1';
export const KNOWLEDGE_LINT_FIX_PREVIEW_SCHEMA = 'sharkcraft.knowledge-lint-fix-preview/v1';

export enum KnowledgeLintCategory {
  SafeMechanicalStub = 'safe-mechanical-stub',
  NeedsHumanWording = 'needs-human-wording',
  ShouldAcknowledge = 'should-acknowledge',
  ObsoleteEntry = 'obsolete-entry',
  StaleReference = 'stale-reference',
  MissingProvenance = 'missing-provenance',
  MissingActionHints = 'missing-action-hints',
}

export enum KnowledgeLintSeverity {
  Info = 'info',
  Warning = 'warning',
}

export interface IKnowledgeLintFinding {
  code: string;
  category: KnowledgeLintCategory;
  severity: KnowledgeLintSeverity;
  entryId: string;
  field: string;
  message: string;
  /** A safe, mechanical hint — ONLY populated when category=SafeMechanicalStub. */
  stubSuggestion?: string;
  /** Set when the lint is opt-in advisory (does not affect exit code). */
  advisory?: boolean;
}

export interface IKnowledgeLintReport {
  schema: typeof KNOWLEDGE_LINT_SCHEMA;
  generatedAt: string;
  entries: number;
  findings: readonly IKnowledgeLintFinding[];
  counts: Readonly<Record<KnowledgeLintCategory, number>>;
}

export interface IKnowledgeLintOptions {
  /** Restrict lint to specific entry ids. */
  entryIds?: readonly string[];
  /** When true, also emit MissingProvenance / MissingActionHints
   * advisories. Default true. */
  includeAdvisory?: boolean;
  /** External signal: ids whose references are known to be stale (from
   * `buildKnowledgeStaleReport`). The lint just records — it does not
   * re-run stale-check. */
  staleReferenceEntryIds?: readonly string[];
}

export function lintKnowledge(
  entries: readonly IKnowledgeEntry[],
  options: IKnowledgeLintOptions = {},
): IKnowledgeLintReport {
  const findings: IKnowledgeLintFinding[] = [];
  const includeAdvisory = options.includeAdvisory ?? true;
  const stale = new Set(options.staleReferenceEntryIds ?? []);
  const entryFilter = options.entryIds && options.entryIds.length > 0 ? new Set(options.entryIds) : null;

  for (const e of entries) {
    if (entryFilter && !entryFilter.has(e.id)) continue;

    // 1) Summary is missing — safe mechanical stub.
    if (!e.summary || e.summary.trim().length === 0) {
      findings.push({
        code: 'knowledge.summary-missing',
        category: KnowledgeLintCategory.SafeMechanicalStub,
        severity: KnowledgeLintSeverity.Info,
        entryId: e.id,
        field: 'summary',
        message: `Entry "${e.id}" has no summary.`,
        stubSuggestion: stubSummaryFor(e),
      });
    } else if (e.summary.length > 320) {
      findings.push({
        code: 'knowledge.summary-too-long',
        category: KnowledgeLintCategory.NeedsHumanWording,
        severity: KnowledgeLintSeverity.Info,
        entryId: e.id,
        field: 'summary',
        message: `Summary is ${e.summary.length} chars (> 320). Consider tightening the wording.`,
      });
    }

    // 2) Tags missing — safe mechanical stub.
    if (!e.tags || e.tags.length === 0) {
      findings.push({
        code: 'knowledge.tags-missing',
        category: KnowledgeLintCategory.SafeMechanicalStub,
        severity: KnowledgeLintSeverity.Info,
        entryId: e.id,
        field: 'tags',
        message: `Entry "${e.id}" has no tags.`,
        stubSuggestion: stubTagsFor(e).join(','),
      });
    }

    // 3) Content is a stub.
    const trimmed = (e.content ?? '').trim();
    if (trimmed.length === 0 || trimmed.startsWith('TODO') || trimmed === '...') {
      findings.push({
        code: 'knowledge.content-stub',
        category: KnowledgeLintCategory.NeedsHumanWording,
        severity: KnowledgeLintSeverity.Warning,
        entryId: e.id,
        field: 'content',
        message: `Entry "${e.id}" has placeholder content. Human wording required.`,
      });
    } else if (trimmed.length < 60) {
      findings.push({
        code: 'knowledge.content-too-short',
        category: KnowledgeLintCategory.NeedsHumanWording,
        severity: KnowledgeLintSeverity.Info,
        entryId: e.id,
        field: 'content',
        message: `Entry "${e.id}" has a very short content body (${trimmed.length} chars).`,
      });
    }

    // 4) Stale references — surfaced from external input.
    if (stale.has(e.id)) {
      findings.push({
        code: 'knowledge.stale-reference',
        category: KnowledgeLintCategory.StaleReference,
        severity: KnowledgeLintSeverity.Warning,
        entryId: e.id,
        field: 'references',
        message: `Entry "${e.id}" has stale or missing references. Run \`shrk knowledge stale-check\` for details.`,
      });
    }

    // 5) Deprecated marker present.
    const md = (e.metadata ?? {}) as Record<string, unknown>;
    if (md.deprecated) {
      findings.push({
        code: 'knowledge.obsolete-entry',
        category: KnowledgeLintCategory.ObsoleteEntry,
        severity: KnowledgeLintSeverity.Info,
        entryId: e.id,
        field: 'metadata.deprecated',
        message: `Entry "${e.id}" is marked deprecated. Consider removing or migrating its references.`,
      });
    }

    // 6) Missing provenance — advisory.
    if (includeAdvisory) {
      const authoring = (md.authoring as Record<string, unknown> | undefined) ?? undefined;
      const source = e.source;
      if (!authoring && !source) {
        findings.push({
          code: 'knowledge.missing-provenance',
          category: KnowledgeLintCategory.MissingProvenance,
          severity: KnowledgeLintSeverity.Info,
          entryId: e.id,
          field: 'metadata.authoring',
          message: `Entry "${e.id}" has no provenance metadata. Consider recording who/why on the next update.`,
          advisory: true,
        });
      }
    }

    // 7) Missing action hints — advisory for high-priority entries.
    if (includeAdvisory && (e.priority === 'critical' || e.priority === 'high')) {
      if (!e.actionHints) {
        findings.push({
          code: 'knowledge.missing-action-hints',
          category: KnowledgeLintCategory.MissingActionHints,
          severity: KnowledgeLintSeverity.Info,
          entryId: e.id,
          field: 'actionHints',
          message: `High-priority entry "${e.id}" has no actionHints. Consider adding mcpTools / commands.`,
          advisory: true,
        });
      }
    }

    // 8) appliesWhen missing — should-acknowledge if intentional.
    if (!e.appliesWhen || e.appliesWhen.length === 0) {
      findings.push({
        code: 'knowledge.appliesWhen-missing',
        category: KnowledgeLintCategory.ShouldAcknowledge,
        severity: KnowledgeLintSeverity.Info,
        entryId: e.id,
        field: 'appliesWhen',
        message: `Entry "${e.id}" has no appliesWhen markers. If this is intentional (e.g. background reading) consider documenting it.`,
      });
    }
  }

  const counts: Record<KnowledgeLintCategory, number> = {
    [KnowledgeLintCategory.SafeMechanicalStub]: 0,
    [KnowledgeLintCategory.NeedsHumanWording]: 0,
    [KnowledgeLintCategory.ShouldAcknowledge]: 0,
    [KnowledgeLintCategory.ObsoleteEntry]: 0,
    [KnowledgeLintCategory.StaleReference]: 0,
    [KnowledgeLintCategory.MissingProvenance]: 0,
    [KnowledgeLintCategory.MissingActionHints]: 0,
  };
  for (const f of findings) counts[f.category]++;

  return {
    schema: KNOWLEDGE_LINT_SCHEMA,
    generatedAt: new Date().toISOString(),
    entries: entries.length,
    findings,
    counts,
  };
}

export interface IKnowledgeLintFixPreview {
  schema: typeof KNOWLEDGE_LINT_FIX_PREVIEW_SCHEMA;
  generatedAt: string;
  /** Per-entry list of mechanical stubs that can be safely applied. */
  safeStubs: ReadonlyArray<{
    entryId: string;
    code: string;
    field: string;
    suggestion: string;
  }>;
  /** Per-entry list of TODO items that need human wording. */
  todos: ReadonlyArray<{
    entryId: string;
    code: string;
    field: string;
    description: string;
  }>;
  /** Per-entry list of items to acknowledge as intentional. */
  acknowledgements: ReadonlyArray<{
    entryId: string;
    code: string;
    field: string;
    description: string;
  }>;
  /** Reverse-link to the source lint report. */
  basedOn: typeof KNOWLEDGE_LINT_SCHEMA;
  /** Files the CLI adapter would write (preview-only). */
  files: ReadonlyArray<{
    path: string;
    purpose: 'markdown-summary' | 'patch' | 'todos-json';
    language: 'markdown' | 'json' | 'typescript';
  }>;
  /** Next commands an agent should run. */
  nextCommands: readonly string[];
}

export function buildKnowledgeLintFixPreview(
  report: IKnowledgeLintReport,
): IKnowledgeLintFixPreview {
  const safeStubs: IKnowledgeLintFixPreview['safeStubs'] = report.findings
    .filter((f) => f.category === KnowledgeLintCategory.SafeMechanicalStub && f.stubSuggestion)
    .map((f) => ({
      entryId: f.entryId,
      code: f.code,
      field: f.field,
      suggestion: f.stubSuggestion!,
    }));

  const todos: IKnowledgeLintFixPreview['todos'] = report.findings
    .filter(
      (f) =>
        f.category === KnowledgeLintCategory.NeedsHumanWording ||
        f.category === KnowledgeLintCategory.StaleReference ||
        f.category === KnowledgeLintCategory.ObsoleteEntry,
    )
    .map((f) => ({
      entryId: f.entryId,
      code: f.code,
      field: f.field,
      description: f.message,
    }));

  const acknowledgements: IKnowledgeLintFixPreview['acknowledgements'] = report.findings
    .filter(
      (f) =>
        f.category === KnowledgeLintCategory.ShouldAcknowledge ||
        f.category === KnowledgeLintCategory.MissingProvenance ||
        f.category === KnowledgeLintCategory.MissingActionHints,
    )
    .map((f) => ({
      entryId: f.entryId,
      code: f.code,
      field: f.field,
      description: f.message,
    }));

  return {
    schema: KNOWLEDGE_LINT_FIX_PREVIEW_SCHEMA,
    generatedAt: new Date().toISOString(),
    safeStubs,
    todos,
    acknowledgements,
    basedOn: KNOWLEDGE_LINT_SCHEMA,
    files: [
      { path: '.sharkcraft/fixes/knowledge-lint.preview.md', purpose: 'markdown-summary', language: 'markdown' },
      { path: '.sharkcraft/fixes/knowledge-lint.todos.json', purpose: 'todos-json', language: 'json' },
      { path: '.sharkcraft/fixes/knowledge-lint.patch', purpose: 'patch', language: 'typescript' },
    ],
    nextCommands: [
      'shrk knowledge lint --json',
      'shrk knowledge stale-check --ci',
      'shrk self-config doctor',
    ],
  };
}

export function renderKnowledgeLintMarkdown(report: IKnowledgeLintReport): string {
  const lines: string[] = [];
  lines.push('# Knowledge lint');
  lines.push('');
  lines.push(`Entries scanned: ${report.entries}`);
  lines.push(`Findings: ${report.findings.length}`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  for (const [cat, n] of Object.entries(report.counts)) {
    if (n > 0) lines.push(`- ${cat}: ${n}`);
  }
  lines.push('');
  if (report.findings.length > 0) {
    lines.push('## Findings');
    lines.push('');
    for (const f of report.findings) {
      lines.push(
        `- **${f.severity.toUpperCase()}** \`${f.code}\` ${f.entryId} → ${f.field}${f.advisory ? ' _(advisory)_' : ''}`,
      );
      lines.push(`  - ${f.message}`);
      if (f.stubSuggestion) lines.push(`  - stub: \`${f.stubSuggestion}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderKnowledgeLintFixPreviewMarkdown(
  preview: IKnowledgeLintFixPreview,
): string {
  const lines: string[] = [];
  lines.push('# Knowledge lint — fix preview');
  lines.push('');
  lines.push(`Safe mechanical stubs: ${preview.safeStubs.length}`);
  lines.push(`Items needing human wording: ${preview.todos.length}`);
  lines.push(`Items to acknowledge: ${preview.acknowledgements.length}`);
  lines.push('');
  lines.push('## Safe mechanical stubs');
  lines.push('');
  if (preview.safeStubs.length === 0) lines.push('_(none)_');
  for (const s of preview.safeStubs) {
    lines.push(`- \`${s.entryId}\` → \`${s.field}\`: \`${s.suggestion}\``);
  }
  lines.push('');
  lines.push('## TODOs (human wording required)');
  lines.push('');
  if (preview.todos.length === 0) lines.push('_(none)_');
  for (const t of preview.todos) {
    lines.push(`- [ ] \`${t.entryId}\` → \`${t.field}\` — ${t.description}`);
  }
  lines.push('');
  lines.push('## Acknowledgements (intentional, advisory)');
  lines.push('');
  if (preview.acknowledgements.length === 0) lines.push('_(none)_');
  for (const a of preview.acknowledgements) {
    lines.push(`- \`${a.entryId}\` → \`${a.field}\` — ${a.description}`);
  }
  lines.push('');
  lines.push('## Next commands');
  lines.push('');
  for (const c of preview.nextCommands) lines.push(`- \`${c}\``);
  lines.push('');
  return lines.join('\n');
}

function stubSummaryFor(e: IKnowledgeEntry): string {
  return `TODO(summary): one-line summary of "${e.title || e.id}".`;
}

function stubTagsFor(e: IKnowledgeEntry): string[] {
  const out = new Set<string>();
  const idTokens = e.id.split(/[.\-]/g).filter((t) => t.length > 1);
  for (const t of idTokens.slice(0, 3)) out.add(t);
  if (e.type) out.add(String(e.type));
  return [...out];
}
