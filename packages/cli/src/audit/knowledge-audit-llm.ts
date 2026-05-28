import { AiMessageRole, type IAiMessage, type IAiProvider } from '@shrkcrft/ai';
import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type {
  IKnowledgeAuditEntry,
  IKnowledgeAuditReport,
  ILlmKnowledgeAuditFinding,
  KnowledgeAuditFindingSeverity,
} from './knowledge-audit.ts';

export interface IEnrichKnowledgeAuditOptions {
  provider: IAiProvider;
  inspection: ISharkcraftInspection;
  maxTokensPerEntry?: number;
  onPerEntryError?: (entryId: string, error: Error) => void;
}

export async function enrichKnowledgeAuditWithLlm(
  report: IKnowledgeAuditReport,
  options: IEnrichKnowledgeAuditOptions,
): Promise<IKnowledgeAuditReport> {
  const enriched: IKnowledgeAuditEntry[] = [];
  for (const entry of report.entries) {
    const ke = options.inspection.knowledgeEntries.find((e) => e.id === entry.entryId);
    if (!ke) {
      enriched.push(entry);
      continue;
    }
    const peers = options.inspection.knowledgeEntries
      .filter((e) => e.id !== ke.id && String(e.type) === String(ke.type))
      .slice(0, 4);
    const messages = buildEnrichmentMessages(ke, peers, entry);
    try {
      const res = await options.provider.send({
        messages,
        maxTokens: options.maxTokensPerEntry ?? 1024,
      });
      if (!res.ok) {
        options.onPerEntryError?.(entry.entryId, res.error as unknown as Error);
        enriched.push(entry);
        continue;
      }
      const parsed = parseLlmFindings(res.value.content);
      enriched.push({ ...entry, llmFindings: parsed });
    } catch (e) {
      options.onPerEntryError?.(entry.entryId, e as Error);
      enriched.push(entry);
    }
  }

  return {
    ...report,
    llmEnriched: true,
    llmProviderId: options.provider.id,
    entries: enriched,
  };
}

function buildEnrichmentMessages(
  entry: IKnowledgeEntry,
  peers: readonly IKnowledgeEntry[],
  auditEntry: IKnowledgeAuditEntry,
): IAiMessage[] {
  const system: IAiMessage = {
    role: AiMessageRole.System,
    content: [
      'You are a critic auditing a SharkCraft knowledge entry for staleness, content quality, and silent drift from sibling entries.',
      'A knowledge entry is a structured piece of project knowledge (a rule, a path convention, a generic knowledge fact) that AI coding agents read when working on the project.',
      '',
      'CRITICAL DISTINCTION — read carefully before flagging anything:',
      '- You are auditing the ENTRY itself, NOT the domain it describes. An entry about "deprecated APIs" is fine even if the APIs it discusses are deprecated; you would only flag it if the entry now teaches the wrong thing about those APIs.',
      '- "References stale" means a file/symbol named in the entry no longer exists. Do not invent stale references — only flag what you can ground in the entry text or supplied deterministic findings.',
      '- A short summary is not automatically a bug. Only flag thin wording when the surrounding context makes the brevity misleading.',
      '',
      'STRICT silence bias: emit a finding only if a senior maintainer would change something on the strength of it. If the deterministic layer already caught it, do not restate. Better silence than ceremony.',
      '',
      'Your job: surface issues the deterministic layer (knowledge lint + knowledge stale-reference check) CANNOT see. Look explicitly for:',
      '  1. **content-drift**         — the entry teaches a pattern that the rest of the corpus has moved past.',
      '  2. **internal-contradiction**— the entry contradicts a peer entry in the same scope.',
      '  3. **doc-content-mismatch**  — `summary`/`description` and the long-form `body` say different things.',
      '  4. **vague-claim**           — the entry uses "always/never/should" without a concrete why or example.',
      '  5. **missing-action-hint**   — actionable rule with no command or MCP-tool reference, where similar peers have them.',
      '  6. **stale-phrasing**        — references a tool/command/workflow that has been renamed or removed.',
      '  7. **other**                 — only if none of the above fit.',
      '',
      'Return ONLY a JSON object with this exact shape, no preface, no fences:',
      '{',
      '  "findings": [',
      '    {',
      '      "severity": "info" | "warn" | "error",',
      '      "category": "content-drift" | "internal-contradiction" | "doc-content-mismatch" | "vague-claim" | "missing-action-hint" | "stale-phrasing" | "other",',
      '      "message": "<one sentence — name specific symbols, commands, or peers when possible>",',
      '      "confidence": 0.0',
      '    }',
      '  ]',
      '}',
      'If nothing new is worth flagging, return {"findings": []}. Never invent symbols, paths, or peer ids not present in the supplied data.',
    ].join('\n'),
  };

  const user: IAiMessage = {
    role: AiMessageRole.User,
    content: [
      `# Knowledge entry under audit`,
      `id: ${entry.id}`,
      `type: ${String(entry.type)}`,
      `title: ${entry.title ?? '(none)'}`,
      `summary: ${entry.summary ?? '(none)'}`,
      `tags: ${(entry.tags ?? []).join(', ') || '(none)'}`,
      ``,
      `## Content (truncated to ~4 KB)`,
      '```',
      truncate(String((entry as { content?: string }).content ?? '(no content)'), 4096),
      '```',
      ``,
      `## Deterministic findings already produced`,
      auditEntry.deterministicFindings.length === 0
        ? '(none)'
        : auditEntry.deterministicFindings
            .map(
              (f) =>
                `- [${f.severity}] ${f.category} (${f.field}): ${f.message} (sources: ${f.sources.join(', ')})`,
            )
            .join('\n'),
      ``,
      `## Sibling entries (same type)`,
      peers.length === 0
        ? '(no peers in this workspace)'
        : peers
            .map((p) => `- ${p.id}: ${p.title ?? '(no title)'} — ${p.summary ?? '(no summary)'}`)
            .join('\n'),
    ].join('\n'),
  };

  return [system, user];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

function parseLlmFindings(raw: string): readonly ILlmKnowledgeAuditFinding[] {
  const trimmed = raw.trim();
  let jsonText = trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const first = jsonText.indexOf('{');
    const last = jsonText.lastIndexOf('}');
    if (first < 0 || last <= first) return [];
    try {
      parsed = JSON.parse(jsonText.slice(first, last + 1));
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return [];
  const out: ILlmKnowledgeAuditFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const severity = coerceSeverity(obj.severity);
    const category = typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : 'other';
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

function coerceSeverity(value: unknown): KnowledgeAuditFindingSeverity {
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  if (value === 'warning') return 'warn';
  return 'info';
}

export const __internals = { buildEnrichmentMessages, parseLlmFindings };
