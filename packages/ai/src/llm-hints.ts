import { selectAiProvider } from './provider-resolver.ts';
import type { AiProviderKind } from './provider-resolver.ts';
import type { IAiProvider } from './ai-provider.ts';

export type AiHintLevel = 'setup' | 'upgrade' | 'info';

export interface IAiHint {
  level: AiHintLevel;
  title: string;
  steps: readonly string[];
}

export interface IAiBlock {
  reachable: boolean;
  requestedProvider: AiProviderKind;
  providerId: string | null;
  enhancementSkipped: boolean;
  hints: readonly IAiHint[];
}

export interface IBuildAiBlockInput {
  /** What `selectAiProvider` returned, or null if the caller didn't try. */
  selection?: { requested: AiProviderKind; provider: IAiProvider | null } | null;
  /** True when --no-enhance was passed (user opted out — don't nag). */
  userOptedOut?: boolean;
}

/**
 * Produces the structured `ai` block that lives on every audit report
 * and any command using `enrichWithLlmRecommendations`. Without the
 * AI block, `--no-enhance` and "no provider reachable" look the same
 * to a downstream agent. The block disambiguates.
 *
 * Lives in `@shrkcrft/ai` so any package (CLI, packs, MCP server's
 * read-only surfaces) can construct the same shape.
 */
export function buildAiBlock(input: IBuildAiBlockInput = {}): IAiBlock {
  // Honour an explicitly-passed selection (including {provider: null} when
  // --no-enhance is in play) without re-probing the auto chain. Only fall
  // back to live probing when the caller didn't supply a selection at all.
  const selection =
    input.selection !== undefined && input.selection !== null
      ? input.selection
      : input.userOptedOut
        ? { requested: 'auto' as AiProviderKind, provider: null as IAiProvider | null }
        : selectAiProvider(undefined);
  const reachable = selection.provider !== null;
  const providerId = selection.provider?.id ?? null;
  const requested = selection.requested;
  const userOptedOut = Boolean(input.userOptedOut);

  const hints: IAiHint[] = [];

  if (!reachable && !userOptedOut) {
    hints.push({
      level: 'setup',
      title: 'Enable LLM enrichment for deeper analysis',
      steps: [
        'Local-first: install Ollama (https://ollama.com/download) or set LLAMACPP_MODEL_PATH for in-process inference.',
        'Pull a model that fits your machine — e.g. `ollama pull llama3.2` (good general-purpose) or `ollama pull qwen2.5-coder:7b` (code-aware).',
        'Optional: export OLLAMA_HOST=http://localhost:11434 (default) or point at a remote daemon.',
        'Optional: export OLLAMA_MODEL=<id> to pin the model used by shrk.',
        'Re-run without --no-enhance. The deterministic findings are unchanged; LLM critique appears under `llmFindings`.',
      ],
    });
  } else if (!reachable && userOptedOut) {
    hints.push({
      level: 'info',
      title: 'LLM enrichment disabled by --no-enhance',
      steps: [
        'Deterministic findings are first-class; LLM is purely additive.',
        'Drop --no-enhance to layer LLM critique on top when a provider is available.',
      ],
    });
  } else {
    hints.push({
      level: 'info',
      title: `LLM enrichment active via ${providerId}`,
      steps: [
        'LLM-derived findings appear with `[llm]` tags and a confidence score.',
        'Tune behavior: --provider ollama|llamacpp, --model <id>, AI_PROVIDER env var (overrides --provider when unset).',
      ],
    });
    hints.push({
      level: 'upgrade',
      title: 'Sharpen LLM output if findings feel thin',
      steps: [
        'Prefer a code-aware model for technical staleness checks (e.g. qwen2.5-coder:7b, deepseek-coder-v2).',
        'Larger models notice more drift but cost latency — try 7B for code, 14B+ for nuanced doc-content review.',
        'For fix-plan enrichment, the same provider is reused; no separate config needed.',
      ],
    });
  }

  return {
    reachable,
    requestedProvider: requested,
    providerId,
    enhancementSkipped: userOptedOut,
    hints,
  };
}

export function renderAiBlockMarkdown(block: IAiBlock): string {
  const out: string[] = [];
  const status = block.reachable
    ? `active via \`${block.providerId}\``
    : block.enhancementSkipped
      ? 'disabled by `--no-enhance`'
      : 'unavailable (no local LLM detected)';
  out.push(`## AI configuration — ${status}`);
  out.push('');
  for (const hint of block.hints) {
    out.push(`### [${hint.level}] ${hint.title}`);
    for (const step of hint.steps) {
      out.push(`- ${step}`);
    }
    out.push('');
  }
  return out.join('\n');
}
