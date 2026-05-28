import { AiMessageRole, type IAiMessage, type IAiProvider } from '@shrkcrft/ai';
import type { ITemplateDefinition } from '@shrkcrft/templates';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import type { IFixInstruction, ITemplateFixPlan } from './templates-fix-plan.ts';

export interface IEnrichFixPlanOptions {
  provider: IAiProvider;
  inspection: ISharkcraftInspection;
  maxTokensPerTemplate?: number;
  onPerTemplateError?: (templateId: string, error: Error) => void;
}

export async function enrichFixPlanWithLlm(
  plan: ITemplateFixPlan,
  options: IEnrichFixPlanOptions,
): Promise<ITemplateFixPlan> {
  const byTemplate = new Map<string, IFixInstruction[]>();
  for (const fix of plan.fixes) {
    const list = byTemplate.get(fix.templateId) ?? [];
    list.push(fix);
    byTemplate.set(fix.templateId, list);
  }

  const enrichedFixes: IFixInstruction[] = [];
  for (const [templateId, fixes] of byTemplate.entries()) {
    const template = options.inspection.templateRegistry.get(templateId);
    if (!template) {
      enrichedFixes.push(...fixes);
      continue;
    }
    try {
      const messages = buildFixSuggestionMessages(template, fixes);
      const res = await options.provider.send({
        messages,
        maxTokens: options.maxTokensPerTemplate ?? 1024,
      });
      if (!res.ok) {
        options.onPerTemplateError?.(templateId, res.error as unknown as Error);
        enrichedFixes.push(...fixes);
        continue;
      }
      const suggestions = parseSuggestionMap(res.value.content);
      for (const fix of fixes) {
        const key = suggestionKey(fix.findingCategory, fix.finding);
        const suggestion = suggestions.get(key) ?? suggestions.get(fix.findingCategory) ?? null;
        enrichedFixes.push(suggestion ? { ...fix, llmSuggestion: suggestion } : fix);
      }
    } catch (e) {
      options.onPerTemplateError?.(templateId, e as Error);
      enrichedFixes.push(...fixes);
    }
  }

  return { ...plan, fixes: enrichedFixes };
}

function suggestionKey(category: string, finding: string): string {
  return `${category}::${finding.slice(0, 80)}`;
}

function buildFixSuggestionMessages(
  template: ITemplateDefinition,
  fixes: readonly IFixInstruction[],
): IAiMessage[] {
  const body =
    typeof (template as { content?: unknown }).content === 'string'
      ? ((template as { content: string }).content)
      : '(function body — not introspectable as a string)';

  const targetPathSource =
    typeof (template as { targetPath?: unknown }).targetPath === 'string'
      ? `string: ${(template as { targetPath: string }).targetPath}`
      : `function (signature only)`;

  const system: IAiMessage = {
    role: AiMessageRole.System,
    content: [
      'You are a senior maintainer sharpening fix recommendations for a SharkCraft scaffold template.',
      'For each finding listed, the deterministic layer has already produced a sound agent prompt with a generic placeholder (e.g. <sample value>, <TODO>).',
      'Your job: replace those placeholders with a CONCRETE recommendation grounded in the supplied template body, variables, and target path.',
      '',
      'Per finding category, prefer to emit:',
      '  - required-var-no-example   → a literal example value, in single quotes, matching any declared pattern and the variable\'s role.',
      '  - undocumented-var          → a one-sentence description anchored in how the variable is used in the body.',
      '  - undeclared-var            → either "ADD: <variable spec>" or "REMOVE: <placeholder>" with a one-line rationale.',
      '  - related-id-unresolved     → confirm removal; if a near-match exists in supplied context, name it.',
      '  - path-no-convention        → either "ADD paths.ts entry: <pattern>" or "CHANGE template targetPath: <pattern>", whichever is less intrusive.',
      '  - missing-name              → a short, descriptive name.',
      '  - missing-description       → a one-sentence description of what the template scaffolds.',
      '  - any other category        → a one-sentence concrete suggestion.',
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
      `# Template: ${template.id}`,
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
                `- ${v.name}${v.required ? ' (required)' : ''}` +
                (v.pattern ? `  pattern=${v.pattern.source}` : '') +
                (v.examples?.length ? `  examples=[${v.examples.join(', ')}]` : '') +
                (v.description ? `\n    ${v.description}` : ''),
            )
            .join('\n'),
      ``,
      `## targetPath`,
      targetPathSource,
      ``,
      `## Template body (truncated to ~3 KB)`,
      '```',
      truncate(body, 3072),
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
    const firstBrace = jsonText.indexOf('{');
    const lastBrace = jsonText.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return out;
    try {
      parsed = JSON.parse(jsonText.slice(firstBrace, lastBrace + 1));
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

export const __internals = { buildFixSuggestionMessages, parseSuggestionMap };
