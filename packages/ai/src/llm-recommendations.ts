import { AiMessageRole, type IAiMessage } from './ai-request.ts';
import type { IAiProvider } from './ai-provider.ts';
import { selectAiProvider, type AiProviderKind } from './provider-resolver.ts';
import { buildAiBlock, type IAiBlock } from './llm-hints.ts';

export type RecommendationSeverity = 'info' | 'warn' | 'error';

export interface ILlmRecommendation {
  severity: RecommendationSeverity;
  category: string;
  /** Short, one-sentence description of what's recommended. */
  title: string;
  /** Detailed prose; typically 1-3 sentences with concrete next-steps. */
  detail: string;
  /** Optional target identifier (rule id, template id, file path) the recommendation applies to. */
  target?: string;
  /** Confidence in [0, 1]; lower for fuzzier judgments. */
  confidence: number;
}

export interface IRecommendationEnvelope {
  /** Always present, even when LLM is unavailable. */
  ai: IAiBlock;
  recommendations: readonly ILlmRecommendation[];
}

export interface IEnrichWithLlmRecommendationsInput {
  /**
   * The shape of the deterministic surface (e.g., 'doctor', 'templates-drift').
   * Used in the LLM prompt so the model knows what it's looking at.
   */
  surface: string;
  /**
   * Human-readable description of the deterministic findings (what's already
   * known). Should be tight — the prompt fits into one LLM call.
   */
  deterministicSummary: string;
  /**
   * Provider kind to request. Defaults to 'auto' (local-first walk).
   */
  providerKind?: string;
  /**
   * Override the auto-selection by passing an already-resolved provider
   * (useful for tests).
   */
  providerOverride?: IAiProvider | null;
  /**
   * True when the caller's --no-enhance equivalent was passed.
   * When true, no LLM call is made and the AI block records the opt-out.
   */
  userOptedOut?: boolean;
  /**
   * Per-surface ask: what should the LLM produce on top of the
   * deterministic summary? E.g. "for each warning, produce one concrete
   * next-step the user can run from the CLI."
   */
  ask: string;
  /**
   * Optional override for the model used by the provider.
   */
  model?: string;
  maxTokens?: number;
}

/**
 * Shared utility for layering LLM recommendations onto any deterministic
 * surface. The deterministic portion is the caller's responsibility; this
 * helper only adds the `ai` block and a structured `recommendations` array.
 *
 * Hard guarantee: if no LLM is reachable (or `userOptedOut` is true), the
 * call is a no-op apart from emitting the `ai` block with setup hints.
 *
 * Lives in `@shrkcrft/ai` so any callable surface (CLI commands, packs,
 * read-only MCP tools that want recommendations alongside their data)
 * can reuse the same envelope shape.
 */
export async function enrichWithLlmRecommendations(
  input: IEnrichWithLlmRecommendationsInput,
): Promise<IRecommendationEnvelope> {
  if (input.userOptedOut) {
    const aiBlock = buildAiBlock({
      selection: { requested: normaliseKind(input.providerKind), provider: null },
      userOptedOut: true,
    });
    return { ai: aiBlock, recommendations: [] };
  }

  const selection = input.providerOverride !== undefined
    ? { requested: normaliseKind(input.providerKind), provider: input.providerOverride }
    : selectAiProvider(input.providerKind);

  if (!selection.provider) {
    const aiBlock = buildAiBlock({ selection, userOptedOut: false });
    return { ai: aiBlock, recommendations: [] };
  }

  if (input.model) selection.provider.configure({ model: input.model });

  const messages = buildRecommendationMessages(input);
  let recommendations: ILlmRecommendation[] = [];
  try {
    const res = await selection.provider.send({
      messages,
      maxTokens: input.maxTokens ?? 1024,
    });
    if (res.ok) {
      recommendations = parseRecommendations(res.value.content);
    }
  } catch {
    // Swallow — recommendations stay empty; ai block still carries provider info.
  }

  const aiBlock = buildAiBlock({ selection, userOptedOut: false });
  return { ai: aiBlock, recommendations };
}

function buildRecommendationMessages(
  input: IEnrichWithLlmRecommendationsInput,
): IAiMessage[] {
  const system: IAiMessage = {
    role: AiMessageRole.System,
    content: [
      `You are a critic layering concrete next-step recommendations on top of a deterministic SharkCraft "${input.surface}" report.`,
      'The deterministic report is supplied verbatim — treat its findings as facts. Your job is to translate them into actions a developer (or an AI coding agent) can take immediately.',
      '',
      'The user-specified ask is:',
      input.ask,
      '',
      'Return ONLY a JSON object with this exact shape, no preface, no fences:',
      '{',
      '  "recommendations": [',
      '    {',
      '      "severity": "info" | "warn" | "error",',
      '      "category": "<short kebab-case category>",',
      '      "title": "<one-sentence summary>",',
      '      "detail": "<one to three sentences with concrete next-steps; name files, commands, or symbols when possible>",',
      '      "target": "<optional id or path>",',
      '      "confidence": 0.0',
      '    }',
      '  ]',
      '}',
      'Skip the bullet entirely if you cannot say anything specific. Better silence than ceremony.',
    ].join('\n'),
  };
  const user: IAiMessage = {
    role: AiMessageRole.User,
    content: [`# Deterministic ${input.surface} summary`, '', input.deterministicSummary].join('\n'),
  };
  return [system, user];
}

function parseRecommendations(raw: string): ILlmRecommendation[] {
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
  const list = (parsed as { recommendations?: unknown }).recommendations;
  if (!Array.isArray(list)) return [];
  const out: ILlmRecommendation[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const severity = coerceSeverity(obj.severity);
    const category = typeof obj.category === 'string' && obj.category.trim()
      ? obj.category.trim()
      : 'other';
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const detail = typeof obj.detail === 'string' ? obj.detail.trim() : '';
    if (!title || !detail) continue;
    const confidence =
      typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
        ? obj.confidence
        : 0.5;
    const target = typeof obj.target === 'string' && obj.target.trim() ? obj.target.trim() : undefined;
    out.push({ severity, category, title, detail, confidence, ...(target ? { target } : {}) });
  }
  return out;
}

function coerceSeverity(value: unknown): RecommendationSeverity {
  if (value === 'error' || value === 'warn' || value === 'info') return value;
  if (value === 'warning') return 'warn';
  return 'info';
}

function normaliseKind(kind: string | undefined): AiProviderKind {
  const known = new Set(['claude', 'gemini', 'ollama', 'llamacpp']);
  if (kind && known.has(kind.toLowerCase())) return kind.toLowerCase() as AiProviderKind;
  return 'auto';
}

export function renderRecommendationsMarkdown(envelope: IRecommendationEnvelope): string {
  const out: string[] = [];
  if (envelope.recommendations.length === 0) {
    out.push('## LLM recommendations');
    out.push('');
    out.push(
      envelope.ai.reachable
        ? '(LLM returned no actionable recommendations — the deterministic output already covers the surface.)'
        : '(LLM unavailable — see the AI configuration block below to enable.)',
    );
    out.push('');
  } else {
    out.push(`## LLM recommendations (${envelope.recommendations.length})`);
    out.push('');
    const order: RecommendationSeverity[] = ['error', 'warn', 'info'];
    for (const sev of order) {
      const group = envelope.recommendations.filter((r) => r.severity === sev);
      if (group.length === 0) continue;
      for (const rec of group) {
        out.push(
          `- **[${sev}]** \`${rec.category}\`${rec.target ? ` (${rec.target})` : ''} — ${rec.title} _(confidence ${rec.confidence.toFixed(2)})_`,
        );
        out.push(`  - ${rec.detail}`);
      }
    }
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push(renderAiHintsCompact(envelope.ai));
  return out.join('\n');
}

function renderAiHintsCompact(ai: IAiBlock): string {
  const out: string[] = [];
  const status = ai.reachable
    ? `active via \`${ai.providerId}\``
    : ai.enhancementSkipped
      ? 'disabled by user'
      : 'unavailable';
  out.push(`### AI configuration — ${status}`);
  for (const hint of ai.hints) {
    out.push(`- [${hint.level}] **${hint.title}**`);
    for (const step of hint.steps) {
      out.push(`  - ${step}`);
    }
  }
  return out.join('\n');
}
