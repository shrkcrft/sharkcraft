import {
  AiMessageRole,
  buildAiBlock,
  renderAiBlockMarkdown,
  selectAiProvider,
  type IAiProvider,
} from '@shrkcrft/ai';
import {
  flagBool,
  flagNumber,
  flagString,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

/**
 * `shrk ai-status` — one-shot self-check of the LLM wiring.
 *
 * Designed for agents (like Claude) that want to know whether shrk's
 * LLM enrichment is going to do anything useful, without having to
 * run a full audit. Three pieces of information:
 *   1. Which provider, if any, the local-first walk would pick.
 *   2. The structured `ai` block (the same one every audit emits) so
 *      the agent can act on the hints.
 *   3. Optional `--ping`: a tiny live request that proves the
 *      provider really responds (the resolver only checks env vars).
 *
 * The deterministic baseline contract: works without LLM. With no
 * provider reachable, the output is still useful — it carries the
 * setup hints.
 */
export const aiStatusCommand: ICommandHandler = {
  name: 'ai-status',
  description:
    'Report which AI provider shrk would use right now, with setup or upgrade hints. `--ping` verifies the provider actually responds. Read-only.',
  usage:
    'shrk ai-status [--provider auto|ollama|llamacpp|claude|gemini] [--ping] [--ping-timeout <ms>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const providerKind = flagString(args, 'provider');
    const json = flagBool(args, 'json');
    const wantPing = flagBool(args, 'ping');
    const pingTimeoutMs = flagNumber(args, 'ping-timeout') ?? 8000;

    const selection = selectAiProvider(providerKind);
    const ai = buildAiBlock({ selection, userOptedOut: false });

    let ping: IPingResult | null = null;
    if (wantPing) {
      ping = selection.provider
        ? await pingProvider(selection.provider, pingTimeoutMs)
        : { ok: false, reason: 'no provider reachable — nothing to ping', elapsedMs: 0 };
    }

    // Freshness-shaped signal, consistent with the other status commands:
    // the LLM wiring is `fresh` when a provider is reachable (and the optional
    // ping succeeded), else `stale` — i.e. shrk is on the deterministic
    // baseline and the setup hints apply.
    const state: 'fresh' | 'stale' = ai.reachable && (!ping || ping.ok) ? 'fresh' : 'stale';

    if (json) {
      process.stdout.write(
        asJson({
          ai,
          state,
          ...(ping ? { ping } : {}),
        }) + '\n',
      );
      return ai.reachable && (!ping || ping.ok) ? 0 : 1;
    }

    process.stdout.write(header('AI status'));
    process.stdout.write(kv('reachable', ai.reachable ? 'yes' : 'no') + '\n');
    process.stdout.write(kv('requested provider', ai.requestedProvider) + '\n');
    process.stdout.write(kv('resolved provider', ai.providerId ?? '(none)') + '\n');
    process.stdout.write(kv('state', state) + '\n');
    if (state === 'stale') {
      process.stdout.write(
        '! stale — no AI provider reachable; running on the deterministic baseline. See the setup hints below.\n',
      );
    }
    if (ping) {
      process.stdout.write(
        kv(
          'ping',
          ping.ok
            ? `ok in ${ping.elapsedMs}ms` + (ping.model ? ` (model: ${ping.model})` : '')
            : `failed: ${ping.reason}`,
        ) + '\n',
      );
    }
    process.stdout.write('\n');
    process.stdout.write(renderAiBlockMarkdown(ai));
    return ai.reachable && (!ping || ping.ok) ? 0 : 1;
  },
};

interface IPingResult {
  ok: boolean;
  reason?: string;
  model?: string;
  elapsedMs: number;
}

async function pingProvider(provider: IAiProvider, timeoutMs: number): Promise<IPingResult> {
  const start = Date.now();
  // Tiny prompt with bounded output — we just want to prove the round-trip works.
  const requestPromise = provider.send({
    messages: [
      { role: AiMessageRole.System, content: 'Respond with the single word: ok' },
      { role: AiMessageRole.User, content: 'ping' },
    ],
    maxTokens: 8,
  });
  const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: new Error(`timed out after ${timeoutMs}ms`) }), timeoutMs);
  });
  try {
    const res = (await Promise.race([requestPromise, timeoutPromise])) as
      | Awaited<typeof requestPromise>
      | { ok: false; error: Error };
    const elapsedMs = Date.now() - start;
    if (!('value' in res) || !res.ok) {
      const reason =
        'error' in res
          ? (res.error as { message?: string }).message ?? String(res.error)
          : 'no response';
      return { ok: false, reason, elapsedMs };
    }
    const value = res.value as { model?: string };
    return {
      ok: true,
      elapsedMs,
      ...(value.model ? { model: value.model } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      reason: (e as Error).message,
      elapsedMs: Date.now() - start,
    };
  }
}

