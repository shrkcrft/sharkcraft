import { AiMessageRole, type IAiMessage, type IAiProvider } from '@shrkcrft/ai';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type {
  AuditFindingSeverity,
  ILlmAuditFinding,
  ITemplateAuditEntry,
  ITemplateAuditReport,
} from './templates-audit.ts';

export interface IEnrichOptions {
  provider: IAiProvider;
  inspection: ISharkcraftInspection;
  maxTokensPerTemplate?: number;
  onPerTemplateError?: (templateId: string, error: Error) => void;
}

export async function enrichAuditWithLlm(
  report: ITemplateAuditReport,
  options: IEnrichOptions,
): Promise<ITemplateAuditReport> {
  const enrichedEntries: ITemplateAuditEntry[] = [];
  for (const entry of report.templates) {
    const template = options.inspection.templateRegistry.get(entry.templateId);
    if (!template) {
      enrichedEntries.push(entry);
      continue;
    }
    const peers = options.inspection.templateRegistry
      .list()
      .filter((t) => t.id !== template.id)
      .slice(0, 4);
    const messages = buildEnrichmentMessages(template, peers, entry);
    try {
      const res = await options.provider.send({
        messages,
        maxTokens: options.maxTokensPerTemplate ?? 1024,
      });
      if (!res.ok) {
        options.onPerTemplateError?.(entry.templateId, res.error as unknown as Error);
        enrichedEntries.push(entry);
        continue;
      }
      const parsed = parseLlmFindings(res.value.content);
      enrichedEntries.push({
        ...entry,
        llmFindings: parsed,
      });
    } catch (e) {
      options.onPerTemplateError?.(entry.templateId, e as Error);
      enrichedEntries.push(entry);
    }
  }

  return {
    ...report,
    llmEnriched: true,
    llmProviderId: options.provider.id,
    templates: enrichedEntries,
  };
}

function buildEnrichmentMessages(
  template: ITemplateDefinition,
  peers: readonly ITemplateDefinition[],
  entry: ITemplateAuditEntry,
): IAiMessage[] {
  const system: IAiMessage = {
    role: AiMessageRole.System,
    content: [
      'You are a critic auditing a SharkCraft scaffold template for staleness, content quality, and silent drift from sibling templates.',
      'You will receive: the template body, its declared variables, a sample target path, the deterministic findings already produced by `shrk templates lint` and `shrk templates drift`, and short summaries of up to four sibling templates.',
      '',
      'CRITICAL DISTINCTION — read carefully before flagging anything:',
      '- You are auditing the TEMPLATE itself (the scaffold), NOT the domain it scaffolds. A template that generates a CLI command is fine even if "CLI commands" as a concept were deprecated; you would only flag the template if its OUTPUT is broken.',
      '- "The template imports X" means a literal `import` statement is in the rendered body. Variable names, type-references via {{placeholders}}, and prose mentions in `description` are NOT imports — do not flag them as api-drift.',
      '- "Naming convention drift" is real only when the template diverges from CONCRETE SIBLINGS. Re-describing a variable name (e.g. "uses `camel` instead of camelCase") is restating the schema, not a finding.',
      '',
      'STRICT silence bias: emit a finding only if a senior maintainer would change something on the strength of it. If the deterministic layer already caught it, do not restate. If you are extrapolating from peer summaries without direct evidence, suppress.',
      '',
      'Your job: surface issues the deterministic layer CANNOT see. Look explicitly for each of the following, in order:',
      '  1. **api-drift**           — the template imports symbols, paths, or APIs that look outdated (renamed, removed, or replaced). Flag specific symbol/path names.',
      '  2. **deprecated-pattern**  — the body uses syntax/idioms a maintainer would call out today (var, == comparisons, removed helpers, old framework APIs).',
      '  3. **doc-content-mismatch**— the `description` and `postGenerationNotes` describe behavior the rendered `content` does not actually produce.',
      '  4. **style-drift**         — the body diverges from sibling templates in naming, formatting, error handling, or registration ceremony.',
      '  5. **missing-variable**    — sibling templates declare a variable this one omits, and the omission looks unintentional.',
      '  6. **content-bug**         — the body contains a subtle bug (off-by-one, wrong return type, broken template literal, missing await) the deterministic layer would not catch.',
      '  7. **stale-phrasing**      — `description`, variable descriptions, or `postGenerationNotes` reference a workflow / file / command that no longer exists or has been renamed.',
      '  8. **other**               — only when none of the above categories fit.',
      '',
      'A finding is worth flagging only if it would change a maintainer\'s decision. Skip ceremonial nits.',
      '',
      'Return ONLY a JSON object with this exact shape, no preface, no markdown fences:',
      '{',
      '  "findings": [',
      '    {',
      '      "severity": "info" | "warn" | "error",',
      '      "category": "api-drift" | "deprecated-pattern" | "doc-content-mismatch" | "style-drift" | "missing-variable" | "content-bug" | "stale-phrasing" | "other",',
      '      "message": "<one sentence — name specific symbols, lines, or peers when possible>",',
      '      "confidence": 0.0',
      '    }',
      '  ]',
      '}',
      'If nothing new is worth flagging, return {"findings": []}. Never invent variable names, file paths, or symbol names not present in the supplied template or peer summaries.',
    ].join('\n'),
  };

  const body =
    typeof (template as { content?: unknown }).content === 'string'
      ? ((template as { content: string }).content)
      : '(function body — not introspectable as a string)';

  const sampleTarget = renderSampleTargetPath(template);

  const user: IAiMessage = {
    role: AiMessageRole.User,
    content: [
      `# Template under audit`,
      `id: ${template.id}`,
      `name: ${template.name}`,
      `description: ${template.description}`,
      `tags: ${template.tags.join(', ') || '(none)'}`,
      ``,
      `## Declared variables`,
      template.variables.length === 0
        ? '(none)'
        : template.variables
            .map(
              (v) =>
                `- ${v.name}${v.required ? ' (required)' : ''}${
                  v.description ? ` — ${v.description}` : ''
                }`,
            )
            .join('\n'),
      ``,
      `## Sample target path`,
      sampleTarget ?? '(unable to render)',
      ``,
      `## Template body (truncated to ~4 KB)`,
      '```',
      truncate(body, 4096),
      '```',
      ``,
      `## Deterministic findings already produced`,
      entry.deterministicFindings.length === 0
        ? '(none)'
        : entry.deterministicFindings
            .map(
              (f) =>
                `- [${f.severity}] ${f.category}: ${f.message} (sources: ${f.sources.join(', ')})`,
            )
            .join('\n'),
      ``,
      `## Sibling templates`,
      peers.length === 0
        ? '(no peers in this workspace)'
        : peers
            .map((p) => {
              const vars = (p.variables ?? [])
                .map((v) => `${v.name}${v.required ? '!' : ''}`)
                .join(', ');
              return `- ${p.id} — ${p.name}\n  vars: ${vars || '(none)'}\n  tags: ${p.tags.join(', ') || '(none)'}`;
            })
            .join('\n\n'),
    ].join('\n'),
  };

  return [system, user];
}

function renderSampleTargetPath(template: ITemplateDefinition): string | null {
  const fn = (template as { targetPath?: unknown }).targetPath;
  if (typeof fn === 'string') return fn;
  if (typeof fn !== 'function') return null;
  const sample: Record<string, string> = { name: 'sample-feature' };
  for (const v of template.variables ?? []) {
    sample[v.name] = v.examples?.[0] ?? v.default ?? `sample-${v.name}`;
  }
  try {
    const result = (fn as (vars: Record<string, string>) => string)(sample);
    return typeof result === 'string' ? result : null;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

function parseLlmFindings(raw: string): readonly ILlmAuditFinding[] {
  const trimmed = raw.trim();
  let jsonText = trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const firstBrace = jsonText.indexOf('{');
    const lastBrace = jsonText.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return [];
    try {
      parsed = JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return [];
  const out: ILlmAuditFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const severity = coerceSeverity(obj.severity);
    const category = typeof obj.category === 'string' && obj.category.trim() ? obj.category : 'other';
    const message = typeof obj.message === 'string' ? obj.message.trim() : '';
    const confidence =
      typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : 0.5;
    if (!message) continue;
    out.push({ severity, category, message, confidence });
  }
  return out;
}

function coerceSeverity(value: unknown): AuditFindingSeverity {
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  if (value === 'warning') return 'warn';
  return 'info';
}

export const __internals = { parseLlmFindings, buildEnrichmentMessages };
