import { AiMessageRole, type IAiMessage, type IAiProvider } from '@shrkcrft/ai';
import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type { IKnowledgeFixInstruction, IKnowledgeFixPlan } from './knowledge-fix-plan.ts';

export interface IEnrichKnowledgeFixPlanOptions {
  provider: IAiProvider;
  inspection: ISharkcraftInspection;
  maxTokensPerEntry?: number;
  onPerEntryError?: (entryId: string, error: Error) => void;
}

export async function enrichKnowledgeFixPlanWithLlm(
  plan: IKnowledgeFixPlan,
  options: IEnrichKnowledgeFixPlanOptions,
): Promise<IKnowledgeFixPlan> {
  const byEntry = new Map<string, IKnowledgeFixInstruction[]>();
  for (const fix of plan.fixes) {
    const list = byEntry.get(fix.entryId) ?? [];
    list.push(fix);
    byEntry.set(fix.entryId, list);
  }

  const enriched: IKnowledgeFixInstruction[] = [];
  for (const [entryId, fixes] of byEntry.entries()) {
    const entry = options.inspection.knowledgeEntries.find((e) => e.id === entryId);
    if (!entry) {
      enriched.push(...fixes);
      continue;
    }
    try {
      const messages = buildFixSuggestionMessages(entry, fixes);
      const res = await options.provider.send({
        messages,
        maxTokens: options.maxTokensPerEntry ?? 1024,
      });
      if (!res.ok) {
        options.onPerEntryError?.(entryId, res.error as unknown as Error);
        enriched.push(...fixes);
        continue;
      }
      const suggestions = parseSuggestionMap(res.value.content);
      for (const fix of fixes) {
        const key = suggestionKey(fix.findingCategory, fix.finding);
        const suggestion = suggestions.get(key) ?? suggestions.get(fix.findingCategory) ?? null;
        enriched.push(suggestion ? { ...fix, llmSuggestion: suggestion } : fix);
      }
    } catch (e) {
      options.onPerEntryError?.(entryId, e as Error);
      enriched.push(...fixes);
    }
  }

  return { ...plan, fixes: enriched };
}

function suggestionKey(category: string, finding: string): string {
  return `${category}::${finding.slice(0, 80)}`;
}

function buildFixSuggestionMessages(
  entry: IKnowledgeEntry,
  fixes: readonly IKnowledgeFixInstruction[],
): IAiMessage[] {
  const system: IAiMessage = {
    role: AiMessageRole.System,
    content: [
      'You are a senior maintainer sharpening fix recommendations for a SharkCraft knowledge entry.',
      'For each finding listed, the deterministic layer has already produced a sound agent prompt with a generic placeholder.',
      'Replace those placeholders with a CONCRETE recommendation grounded in the supplied entry.',
      '',
      'Per finding category, prefer to emit:',
      '  - knowledge.summary-missing   → a concrete one-sentence summary in single quotes.',
      '  - knowledge.tags-missing      → 1–3 concrete kebab-case tags as an array.',
      '  - knowledge.title-missing     → a concrete short title in single quotes.',
      '  - knowledge-stale.stale       → name the likely replacement symbol/path if you can ground it.',
      '  - knowledge-stale.missing     → confirm removal or name a likely replacement.',
      '  - any other category          → a one-sentence concrete suggestion.',
      '',
      'Return ONLY a JSON object with this exact shape, no preface, no fences:',
      '{',
      '  "suggestions": [',
      '    {',
      '      "findingCategory": "<exact category>",',
      '      "finding": "<first 80 chars of the original finding message>",',
      '      "suggestion": "<one to three sentences, concrete>"',
      '    }',
      '  ]',
      '}',
      'Omit entries you cannot meaningfully sharpen — better silence than ceremony.',
    ].join('\n'),
  };

  const user: IAiMessage = {
    role: AiMessageRole.User,
    content: [
      `# Knowledge entry: ${entry.id}`,
      `type: ${String(entry.type)}`,
      `title: ${entry.title ?? '(none)'}`,
      `summary: ${entry.summary ?? '(none)'}`,
      `tags: ${(entry.tags ?? []).join(', ') || '(none)'}`,
      ``,
      `## Content (truncated)`,
      '```',
      truncate(String((entry as { content?: string }).content ?? '(no content)'), 3072),
      '```',
      ``,
      `## Fixes needing sharpening`,
      fixes
        .map(
          (f, i) =>
            `### Fix ${i + 1}: ${f.findingCategory}\nfinding: ${f.finding}\ncurrent agent prompt:\n${f.agentPrompt}`,
        )
        .join('\n\n'),
    ].join('\n'),
  };
  return [system, user];
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

function parseSuggestionMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
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
    if (first < 0 || last <= first) return out;
    try {
      parsed = JSON.parse(jsonText.slice(first, last + 1));
    } catch {
      return out;
    }
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const list = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const category = typeof obj.findingCategory === 'string' ? obj.findingCategory.trim() : '';
    const finding = typeof obj.finding === 'string' ? obj.finding.trim() : '';
    const suggestion = typeof obj.suggestion === 'string' ? obj.suggestion.trim() : '';
    if (!category || !suggestion) continue;
    const key = finding ? suggestionKey(category, finding) : category;
    out.set(key, suggestion);
  }
  return out;
}
