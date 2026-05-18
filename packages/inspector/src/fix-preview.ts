/**
 * Fix preview system.
 *
 * Generates safe, preview-only fix suggestions for high-friction findings:
 *  - missing action hints
 *  - stale knowledge references / anchors
 *  - template drift (legacy path / missing path convention)
 *
 * Default behaviour is "preview only": the function returns structured data
 * the CLI can render. When `--write-preview` is passed, the CLI writes the
 * preview under `.sharkcraft/fixes/`. Source code is never modified by the
 * preview path. The hints are explicitly marked stubbed/needs-human-fill so
 * doctor continues to warn until they are addressed.
 *
 * Read-only at the inspector level. Schema: sharkcraft.fix-preview/v1
 */
import {
  diagnoseActionHints,
  type IActionHintQualityIssue,
} from './action-hint-diagnostics.ts';
import {
  buildKnowledgeStaleReport,
  ReferenceCheckOutcome,
} from './knowledge-stale.ts';
import { buildTemplateDriftReport } from './template-drift.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const FIX_PREVIEW_SCHEMA = 'sharkcraft.fix-preview/v1';

export enum FixKind {
  ActionHints = 'action-hints',
  KnowledgeStale = 'knowledge-stale',
  TemplateDrift = 'template-drift',
  Boundary = 'boundary',
  Convention = 'convention',
  SelfConfig = 'self-config',
  PackConflict = 'pack-conflict',
  StalePackSignature = 'stale-pack-signature',
  MissingCommandHint = 'missing-command-hint',
  MissingConventionReference = 'missing-convention-reference',
  MissingTemplateReference = 'missing-template-reference',
  BrokenPlaybookReference = 'broken-playbook-reference',
  BrokenAgentTestReference = 'broken-agent-test-reference',
  BrokenRoutingHintReference = 'broken-routing-hint-reference',
  BrokenHelperReference = 'broken-helper-reference',
}

export interface IFixPreviewSuggestion {
  kind: FixKind;
  targetId: string;
  /** Severity of the underlying finding. */
  severity: 'info' | 'warning' | 'error';
  /** Stable id for the suggestion (kind + slugified target). */
  id?: string;
  /** Confidence in the suggestion: high (deterministic) → low (heuristic). */
  confidence?: 'high' | 'medium' | 'low';
  /** Whether a human must review before applying the suggestion. */
  humanReviewRequired?: boolean;
  /** Reason classification text shown alongside title/description. */
  reason?: string;
  title: string;
  description: string;
  /** Concrete next commands the developer should run. */
  nextCommands: readonly string[];
  /** Stubbed body the developer should fill in. Always preview/draft. */
  draftBody?: string;
  /** Optional file the preview can be written under .sharkcraft/fixes/. */
  previewFileName?: string;
  /** Optional patch preview body (already substituted). */
  patchPreview?: string;
  /** When true, the suggestion is a stub and doctor must keep warning. */
  stubbed: boolean;
}

export interface IFixPreviewReport {
  schema: typeof FIX_PREVIEW_SCHEMA;
  generatedAt: string;
  kinds: readonly FixKind[];
  suggestions: readonly IFixPreviewSuggestion[];
}

export interface IFixPreviewOptions {
  kinds?: readonly FixKind[];
}

/**
 * Write fix-preview drafts to `.sharkcraft/fixes/<filename>`. Returns
 * the absolute paths written. Never touches source files; never overwrites a
 * file outside the fixes directory.
 */
export interface IFixPreviewWriteResult {
  written: readonly { suggestionId: string; absolutePath: string; bytes: number }[];
  skipped: readonly { suggestionId: string; reason: string }[];
}

export async function writeFixPreviewDrafts(
  projectRoot: string,
  report: IFixPreviewReport,
): Promise<IFixPreviewWriteResult> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const nodePath = await import('node:path');
  const dir = nodePath.join(projectRoot, '.sharkcraft', 'fixes');
  mkdirSync(dir, { recursive: true });
  const written: { suggestionId: string; absolutePath: string; bytes: number }[] = [];
  const skipped: { suggestionId: string; reason: string }[] = [];
  for (const s of report.suggestions) {
    if (!s.previewFileName || !s.draftBody) {
      skipped.push({
        suggestionId: s.id ?? `${s.kind}:${s.targetId}`,
        reason: 'no previewFileName or draftBody',
      });
      continue;
    }
    // Resolve safely under .sharkcraft/fixes/ — refuse escape attempts.
    const abs = nodePath.resolve(dir, s.previewFileName);
    if (!abs.startsWith(dir + nodePath.sep) && abs !== dir) {
      skipped.push({ suggestionId: s.id ?? `${s.kind}:${s.targetId}`, reason: 'unsafe path' });
      continue;
    }
    const body =
      `# Fix preview — ${s.kind}\n` +
      `# Target: ${s.targetId}\n` +
      (s.reason ? `# Reason: ${s.reason}\n` : '') +
      (s.confidence ? `# Confidence: ${s.confidence}\n` : '') +
      (s.humanReviewRequired ? `# Requires human review.\n` : '') +
      `\n` +
      s.draftBody +
      `\n` +
      (s.patchPreview ? `\n---\nPatch preview:\n${s.patchPreview}\n` : '');
    writeFileSync(abs, body, 'utf8');
    written.push({
      suggestionId: s.id ?? `${s.kind}:${s.targetId}`,
      absolutePath: abs,
      bytes: Buffer.byteLength(body, 'utf8'),
    });
  }
  return { written, skipped };
}

function buildActionHintFix(issue: IActionHintQualityIssue): IFixPreviewSuggestion {
  const draftBody = [
    `// PREVIEW — stubbed action hints for ${issue.entryId}`,
    `// needs-human-fill: replace TODO placeholders with concrete values.`,
    `actionHints: {`,
    `  commands: [/* TODO: relevant shrk commands */],`,
    `  mcpTools: [/* TODO: read-only MCP tool names */],`,
    `  forbiddenActions: [/* TODO: things the agent must not do */],`,
    `  verificationCommands: [/* TODO: shrk check / lint / tsc invocations */],`,
    `  writePolicy: /* TODO: 'human-only' | 'cli-only' | 'forbidden' */,`,
    `  relatedTemplates: [/* TODO: template ids */],`,
    `  relatedPathConventions: [/* TODO: path convention ids */],`,
    `}`,
  ].join('\n');
  return {
    kind: FixKind.ActionHints,
    targetId: issue.entryId,
    severity: 'warning',
    title: `Action hints stub for "${issue.entryId}"`,
    description: `${issue.code}: ${issue.message}`,
    nextCommands: [
      `shrk knowledge get ${issue.entryId}`,
      `shrk fix preview --action-hints --target ${issue.entryId} --write-preview`,
    ],
    draftBody,
    previewFileName: `action-hints-${slug(issue.entryId)}.preview.md`,
    stubbed: true,
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function buildFixPreview(
  inspection: ISharkcraftInspection,
  options: IFixPreviewOptions = {},
): IFixPreviewReport {
  const defaultKinds: readonly FixKind[] = [
    FixKind.ActionHints,
    FixKind.KnowledgeStale,
    FixKind.TemplateDrift,
    FixKind.SelfConfig,
    FixKind.PackConflict,
    FixKind.StalePackSignature,
  ];
  const kinds = new Set<FixKind>(options.kinds ?? defaultKinds);
  const suggestions: IFixPreviewSuggestion[] = [];

  if (kinds.has(FixKind.ActionHints)) {
    const hints = diagnoseActionHints(inspection.knowledgeEntries);
    for (const issue of hints.issues) {
      suggestions.push(buildActionHintFix(issue));
    }
  }

  if (kinds.has(FixKind.KnowledgeStale)) {
    const stale = buildKnowledgeStaleReport(inspection);
    for (const c of stale.referenceChecks) {
      if (c.outcome === ReferenceCheckOutcome.Ok) continue;
      const target =
        c.reference.id ?? c.reference.path ?? c.reference.symbol ?? '<unknown>';
      suggestions.push({
        kind: FixKind.KnowledgeStale,
        targetId: c.entryId,
        severity: c.outcome === ReferenceCheckOutcome.Missing ? 'error' : 'warning',
        title: `Stale reference ${c.entryId} → ${target}`,
        description: c.message,
        nextCommands: [
          `shrk knowledge references ${c.entryId}`,
          `shrk knowledge rename-symbol <old> <new> --dry-run`,
          `shrk fix preview --knowledge-stale ${c.entryId}`,
        ],
        ...(c.suggestion ? { draftBody: `// suggestion: ${c.suggestion}` } : {}),
        previewFileName: `knowledge-stale-${slug(c.entryId)}.preview.md`,
        stubbed: true,
      });
    }
  }

  if (kinds.has(FixKind.TemplateDrift)) {
    const drift = buildTemplateDriftReport(inspection, {});
    for (const e of drift.entries) {
      for (const i of e.issues) {
        if (i.severity === 'info') continue;
        suggestions.push({
          kind: FixKind.TemplateDrift,
          targetId: e.templateId,
          severity: i.severity,
          title: `Template drift ${e.templateId} — ${i.code}`,
          description: i.message,
          nextCommands: [
            `shrk templates get ${e.templateId}`,
            `shrk paths list`,
            `shrk fix preview --template-drift ${e.templateId} --write-preview`,
          ],
          ...(i.suggestedFix ? { draftBody: `// suggestion: ${i.suggestedFix}` } : {}),
          previewFileName: `template-drift-${slug(e.templateId)}-${i.code}.preview.md`,
          stubbed: true,
        });
      }
    }
  }

  // expansions pull from self-config doctor + pack contributions.
  if (kinds.has(FixKind.SelfConfig)) {
    // self-config doctor returns findings; map each into a fix preview suggestion.
    // Imported lazily to avoid a cycle (self-config-doctor imports plenty).
  }
  if (kinds.has(FixKind.PackConflict) || kinds.has(FixKind.StalePackSignature) || kinds.has(FixKind.SelfConfig)) {
    // Compute pack inventory once; reuse for both kinds.
    // (Imported lazily inside the helper below.)
    void inspection;
  }

  return {
    schema: FIX_PREVIEW_SCHEMA,
    generatedAt: new Date().toISOString(),
    kinds: Array.from(kinds),
    suggestions: suggestions.map(annotateSuggestion),
  };
}

/**
 * Decorate a suggestion with stable id + confidence + human-review
 * defaults derived from its kind/severity. Suggestions already carrying
 * these fields keep their values.
 */
function annotateSuggestion(s: IFixPreviewSuggestion): IFixPreviewSuggestion {
  const id = s.id ?? `${s.kind}:${slug(s.targetId)}`;
  let confidence: 'high' | 'medium' | 'low' = s.confidence ?? 'medium';
  let humanReview = s.humanReviewRequired ?? false;
  switch (s.kind) {
    case FixKind.KnowledgeStale:
    case FixKind.MissingCommandHint:
    case FixKind.MissingConventionReference:
    case FixKind.MissingTemplateReference:
    case FixKind.BrokenPlaybookReference:
    case FixKind.BrokenAgentTestReference:
    case FixKind.BrokenRoutingHintReference:
    case FixKind.BrokenHelperReference:
      confidence = s.confidence ?? 'high';
      break;
    case FixKind.SelfConfig:
    case FixKind.PackConflict:
    case FixKind.StalePackSignature:
      confidence = s.confidence ?? 'high';
      humanReview = s.humanReviewRequired ?? true;
      break;
    case FixKind.ActionHints:
    case FixKind.TemplateDrift:
    case FixKind.Convention:
    case FixKind.Boundary:
      humanReview = s.humanReviewRequired ?? true;
      break;
  }
  return {
    ...s,
    id,
    confidence,
    humanReviewRequired: humanReview,
    reason: s.reason ?? s.description.split('\n')[0],
  };
}

/** Asynchronous expansion that wires the extended fix kinds. The synchronous
 *  `buildFixPreview` keeps the original surface for back-compat; new kinds
 *  arrive via `buildFixPreviewExtended`. */
export async function buildFixPreviewExtended(
  inspection: ISharkcraftInspection,
  options: IFixPreviewOptions = {},
): Promise<IFixPreviewReport> {
  const sync = buildFixPreview(inspection, options);
  const kinds = new Set<FixKind>(options.kinds ?? sync.kinds);
  const suggestions: IFixPreviewSuggestion[] = [...sync.suggestions];

  if (kinds.has(FixKind.SelfConfig)) {
    const { buildSelfConfigDoctorReport } = await import('./self-config-doctor.ts');
    const report = await buildSelfConfigDoctorReport(inspection);
    for (const f of report.findings) {
      const severity: 'info' | 'warning' | 'error' =
        f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info';
      suggestions.push({
        kind: FixKind.SelfConfig,
        targetId: f.referencingId ?? f.referencedId ?? f.code,
        severity,
        title: `Self-config: ${f.code}`,
        description: f.message,
        nextCommands: f.nextCommand ? [f.nextCommand] : ['shrk self-config doctor'],
        stubbed: true,
      });
    }
  }

  if (kinds.has(FixKind.PackConflict) || kinds.has(FixKind.StalePackSignature)) {
    const { buildPackContributionsInventory } = await import('./pack-contributions-inventory.ts');
    const inv = buildPackContributionsInventory(inspection);
    for (const c of inv.conflicts) {
      if (c.kind === 'stale-signature' && kinds.has(FixKind.StalePackSignature)) {
        suggestions.push({
          kind: FixKind.StalePackSignature,
          targetId: c.id,
          severity: 'warning',
          title: `Stale pack signature: ${c.id}`,
          description: c.message,
          nextCommands: c.nextCommand ? [c.nextCommand] : [],
          stubbed: true,
        });
      } else if (c.kind !== 'stale-signature' && kinds.has(FixKind.PackConflict)) {
        suggestions.push({
          kind: FixKind.PackConflict,
          targetId: c.id,
          severity: c.severity,
          title: `Pack conflict: ${c.kind}`,
          description: c.message,
          nextCommands: c.nextCommand ? [c.nextCommand] : ['shrk packs conflicts'],
          stubbed: true,
        });
      }
    }
  }

  // The "missing-*" / "broken-*" kinds derive from the self-config findings
  // we already collected above when `SelfConfig` is requested. When a caller
  // asks for them specifically, surface only the relevant codes.
  const codeMap: Partial<Record<FixKind, RegExp>> = {
    [FixKind.MissingCommandHint]: /missing-command-hint|command-hint-missing/i,
    [FixKind.MissingConventionReference]: /missing-convention/i,
    [FixKind.MissingTemplateReference]: /agent-test-template-missing|template-missing/i,
    [FixKind.BrokenPlaybookReference]: /playbook-missing|broken-playbook/i,
    [FixKind.BrokenAgentTestReference]: /agent-test-knowledge-missing|agent-test-template-missing/i,
    [FixKind.BrokenRoutingHintReference]: /routing-hint-missing/i,
    [FixKind.BrokenHelperReference]: /helper-missing/i,
    [FixKind.Boundary]: /boundary/i,
    [FixKind.Convention]: /convention/i,
  };
  for (const [kind, re] of Object.entries(codeMap) as [FixKind, RegExp][]) {
    if (!kinds.has(kind)) continue;
    if (kind === FixKind.SelfConfig) continue;
    const matched = suggestions.filter(
      (s) => s.kind === FixKind.SelfConfig && re.test(s.title + ' ' + s.description),
    );
    for (const m of matched) {
      suggestions.push({ ...m, kind });
    }
  }

  return {
    schema: FIX_PREVIEW_SCHEMA,
    generatedAt: new Date().toISOString(),
    kinds: Array.from(kinds),
    suggestions,
  };
}

export function listFixKinds(): readonly { kind: FixKind; description: string }[] {
  return [
    { kind: FixKind.ActionHints, description: 'Stubbed action-hint scaffolds for entries flagged by `shrk doctor`.' },
    { kind: FixKind.KnowledgeStale, description: 'Stale references / anchors — preview only.' },
    { kind: FixKind.TemplateDrift, description: 'Template drift remediation (legacy paths / missing path conventions).' },
    { kind: FixKind.Boundary, description: 'Boundary violations introduced by changed files — preview only.' },
    { kind: FixKind.Convention, description: 'Convention violations from `shrk conventions check`.' },
    { kind: FixKind.SelfConfig, description: 'Broken cross-references surfaced by `shrk self-config doctor`.' },
    { kind: FixKind.PackConflict, description: 'Conflicts surfaced by `shrk packs conflicts` (excluding signature).' },
    { kind: FixKind.StalePackSignature, description: 'Stale pack manifest signatures — emits the exact re-sign command. Never fake-signs.' },
    { kind: FixKind.MissingCommandHint, description: 'Knowledge entries whose actionHints reference unknown commands.' },
    { kind: FixKind.MissingConventionReference, description: 'Templates/scaffolds that reference unknown convention ids.' },
    { kind: FixKind.MissingTemplateReference, description: 'Agent tests / playbooks that reference unknown template ids.' },
    { kind: FixKind.BrokenPlaybookReference, description: 'Cross-refs to playbook ids that no longer exist.' },
    { kind: FixKind.BrokenAgentTestReference, description: 'Agent-test expected ids that no longer resolve.' },
    { kind: FixKind.BrokenRoutingHintReference, description: 'Task routing hints pointing at unknown ids.' },
    { kind: FixKind.BrokenHelperReference, description: 'Refs to pack helpers that no longer exist.' },
  ];
}

export function renderFixPreviewMarkdown(report: IFixPreviewReport): string {
  const lines: string[] = [];
  lines.push(`# Fix preview`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Kinds: ${report.kinds.join(', ')}`);
  lines.push('');
  if (report.suggestions.length === 0) {
    lines.push('No outstanding fixes — nothing to preview.');
    return lines.join('\n') + '\n';
  }
  for (const s of report.suggestions) {
    lines.push(`## ${s.kind} — ${s.title}`);
    lines.push(`- target: \`${s.targetId}\``);
    lines.push(`- severity: ${s.severity}`);
    lines.push(`- stubbed: ${s.stubbed ? 'yes (needs-human-fill)' : 'no'}`);
    lines.push('');
    lines.push(s.description);
    lines.push('');
    if (s.draftBody) {
      lines.push('```ts');
      lines.push(s.draftBody);
      lines.push('```');
      lines.push('');
    }
    if (s.nextCommands.length > 0) {
      lines.push('Next commands:');
      for (const c of s.nextCommands) lines.push(`- \`${c}\``);
      lines.push('');
    }
  }
  return lines.join('\n');
}
