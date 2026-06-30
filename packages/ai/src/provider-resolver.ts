import type { IAiProvider } from './ai-provider.ts';
import { ClaudeProvider } from './claude/claude-provider.ts';
import { GeminiProvider } from './gemini/gemini-provider.ts';
import { OllamaProvider } from './ollama/ollama-provider.ts';
import { LlamaCppProvider } from './llamacpp/llama-cpp-provider.ts';

export type AiProviderKind = 'auto' | 'claude' | 'gemini' | 'ollama' | 'llamacpp';

/**
 * Resolve an AI provider by kind.
 *
 * The selector is layered so callers can stay terse:
 *   - `selectAiProvider('llamacpp' | 'ollama' | 'claude' | 'gemini')`
 *     → explicit pick. Returned even when `isReady()` is true; the
 *     caller decides what to do with a non-ready provider.
 *   - `selectAiProvider('auto')` (or `undefined`) → walk the local-first
 *     readiness chain: `llamacpp → ollama`. This is the default for
 *     SharkCraft: privacy + offline first, no surprise network calls
 *     to hosted APIs.
 *
 * Gemini and Claude are deliberately excluded from the `auto` chain.
 * They are still callable via explicit `--provider gemini` /
 * `--provider claude` (or `AI_PROVIDER=gemini` / `AI_PROVIDER=claude`)
 * for users who keep API keys around — but the system never reaches
 * out to a hosted LLM on its own.
 *
 * An unrecognised kind collapses to `'auto'` so the caller never has
 * to validate user input twice.
 */
export function selectAiProvider(
  kind?: string,
): { requested: AiProviderKind; provider: IAiProvider | null } {
  const normalised = normaliseKind(kind);
  if (normalised === 'claude') {
    const provider = new ClaudeProvider();
    return { requested: 'claude', provider: provider.isReady() ? provider : null };
  }
  if (normalised === 'gemini') {
    const provider = new GeminiProvider();
    return { requested: 'gemini', provider: provider.isReady() ? provider : null };
  }
  if (normalised === 'ollama') {
    const provider = new OllamaProvider();
    return { requested: 'ollama', provider: provider.isReady() ? provider : null };
  }
  if (normalised === 'llamacpp') {
    const provider = new LlamaCppProvider();
    return { requested: 'llamacpp', provider: provider.isReady() ? provider : null };
  }
  return autoSelect();
}

function normaliseKind(kind: string | undefined): AiProviderKind {
  const known = new Set(['claude', 'gemini', 'ollama', 'llamacpp']);
  if (kind !== undefined) {
    const explicit = kind.trim().toLowerCase();
    // An explicit `auto` is itself a request — the user is asking for the
    // local-first chain. It must NOT be overridden by AI_PROVIDER (which
    // could be `claude`/`gemini` and would silently ship the deterministic
    // seed — CLAUDE.md + knowledge + file paths — off-machine to a hosted
    // API). AI_PROVIDER is consulted ONLY when no kind was passed at all.
    if (explicit === 'auto') return 'auto';
    if (known.has(explicit)) return explicit as AiProviderKind;
  }
  const envCandidate = (process.env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (known.has(envCandidate)) return envCandidate as AiProviderKind;
  return 'auto';
}

function autoSelect(): { requested: AiProviderKind; provider: IAiProvider | null } {
  for (const kind of defaultAutoChain()) {
    if (kind === 'llamacpp') {
      const provider = new LlamaCppProvider();
      if (provider.isReady()) return { requested: 'auto', provider };
    } else if (kind === 'ollama') {
      const provider = new OllamaProvider();
      if (provider.isReady()) return { requested: 'auto', provider };
    }
  }
  return { requested: 'auto', provider: null };
}

/**
 * Local-first chain. Hosted providers (Gemini, Claude) are
 * intentionally absent — opting into a hosted API has to be explicit
 * via `--provider <name>` or `AI_PROVIDER=<name>`.
 */
function defaultAutoChain(): Array<'llamacpp' | 'ollama'> {
  return ['llamacpp', 'ollama'];
}
