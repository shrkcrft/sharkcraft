import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { AbstractAiProvider } from '../ai-provider.ts';
import { AiMessageRole, type IAiRequest, type IAiResponse } from '../ai-request.ts';

const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3.1';
const DEFAULT_OLLAMA_PORT = 11434;

/**
 * HTTP adapter for a local Ollama instance (https://ollama.com).
 *
 * Unlike Gemini/Claude, Ollama is host-based and does not need an API
 * key — `isReady()` is always true; the actual reachability check is
 * deferred to `send()`. The host is picked from `OLLAMA_HOST` (or the
 * provider config). Two forms are accepted:
 *   - A full URL, e.g. `OLLAMA_HOST=http://my-box:11434`.
 *   - A bare hostname (or IP) when paired with `OLLAMA_PORT`, e.g.
 *     `OLLAMA_HOST=my-box` + `OLLAMA_PORT=11434`. The URL is assembled
 *     as `http://<host>:<port>`.
 * Falls back to `http://localhost:11434`. The default model comes from
 * `OLLAMA_MODEL` and may be overridden per request.
 *
 * Wire format: `POST /api/chat` with `{model, messages, stream:false,
 * format?, options}`. The provider-neutral `IAiMessage` roles map
 * directly onto Ollama roles. When `responseFormat` is supplied we ask
 * Ollama for structured output — newer servers accept a JSON-schema
 * object as `format`, older servers fall back to `format: "json"`.
 */
export class OllamaProvider extends AbstractAiProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama (local HTTP)';

  isReady(): boolean {
    return true;
  }

  /**
   * One-shot preflight against `GET /api/tags`.
   *
   * Why this exists: Ollama is the one provider whose readiness is
   * decoupled from env (the daemon may be down, the model may not be
   * pulled). The two-stage planner calls this *before* stage 1 so it
   * can fail with `ollama serve` / `ollama pull <model>` hints instead
   * of a confusing network error mid-call.
   *
   * `requireModel` (optional) is checked against the server's tag list
   * and reported separately so the caller can build a precise hint.
   */
  async healthCheck(
    requireModel?: string,
  ): Promise<Result<{ host: string; models: string[]; modelPresent: boolean | null }, AppError>> {
    const baseUrl = resolveBaseUrl(this.config.baseUrl);
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
      if (!res.ok) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.IO_ERROR,
            `Ollama health-check failed at ${baseUrl}/api/tags (HTTP ${res.status})`,
            { suggestion: `Is OLLAMA_HOST correct? Currently ${baseUrl}.` },
          ),
        );
      }
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      const models = (json.models ?? []).map((m) => m.name ?? '').filter((n) => n.length > 0);
      const modelPresent = requireModel ? models.includes(requireModel) : null;
      return ok({ host: baseUrl, models, modelPresent });
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.IO_ERROR,
          `Cannot reach Ollama at ${baseUrl}: ${(e as Error).message}`,
          {
            cause: e,
            suggestion: `Start the daemon (\`ollama serve\`) or set OLLAMA_HOST to a reachable instance.`,
          },
        ),
      );
    }
  }

  async send(request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
    const baseUrl = resolveBaseUrl(this.config.baseUrl);
    const model =
      request.model ?? this.config.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
    const maxTokens = request.maxTokens ?? 4096;

    const messages = request.messages.map((m) => ({
      role: roleFor(m.role),
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      options: {
        num_predict: maxTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
    };
    const format = formatFor(request.responseFormat);
    if (format !== undefined) body.format = format;

    // Per-call wall-clock timeout. Without this a slow local model (a large
    // 20B+ model, or one still loading) hangs the request indefinitely — the
    // root cause of `smart-context` "running too long". Manual controller +
    // timer (rather than AbortSignal.timeout) so the catch can distinguish a
    // timeout from an unrelated network error.
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
    let timedOut = false;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text();
        return err(
          new AppErrorImpl(
            ERROR_CODES.IO_ERROR,
            `Ollama API ${res.status}: ${text.slice(0, 500)}`,
            {
              suggestion: `Check OLLAMA_HOST (currently ${baseUrl}) and that the model "${model}" is pulled (\`ollama pull ${model}\`).`,
            },
          ),
        );
      }
      const json = (await res.json()) as IOllamaChatResponse;
      const content = json.message?.content ?? '';
      return ok({
        content,
        model: json.model ?? model,
        finishReason: json.done_reason,
        usage: {
          inputTokens: json.prompt_eval_count,
          outputTokens: json.eval_count,
        },
        raw: json,
      });
    } catch (e) {
      if (timedOut) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.TIMEOUT,
            `Ollama call exceeded ${timeoutMs}ms and was aborted (model "${model}").`,
            {
              suggestion: `The model is too slow for the budget. Try a smaller --model, fewer --enhance-passes, or raise the budget.`,
            },
          ),
        );
      }
      return err(
        new AppErrorImpl(
          ERROR_CODES.IO_ERROR,
          `Failed to call Ollama at ${baseUrl}: ${(e as Error).message}`,
          {
            cause: e,
            suggestion: `Is Ollama running? Try \`ollama serve\` or set OLLAMA_HOST to a reachable instance.`,
          },
        ),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function roleFor(role: AiMessageRole): 'system' | 'user' | 'assistant' {
  if (role === AiMessageRole.System) return 'system';
  if (role === AiMessageRole.Assistant) return 'assistant';
  return 'user';
}

function formatFor(
  responseFormat: IAiRequest['responseFormat'],
): string | Record<string, unknown> | undefined {
  if (!responseFormat) return undefined;
  if (responseFormat.type === 'json_schema' && responseFormat.schema) {
    return responseFormat.schema;
  }
  return 'json';
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Resolve the Ollama base URL from config + env. Accepts:
 *   - An explicit base URL on the provider config (`baseUrl`).
 *   - `OLLAMA_HOST` as a full URL (`http://my-box:11434`).
 *   - `OLLAMA_HOST` as a bare host (`my-box`) paired with
 *     `OLLAMA_PORT` (default 11434 if only host is given).
 *   - Falls back to `http://localhost:11434`.
 *
 * Why split host/port: lets the user point at a remote Ollama with two
 * dotenv entries instead of having to remember the URL form. Both
 * styles coexist; if `OLLAMA_HOST` already contains a scheme we keep
 * it verbatim and ignore `OLLAMA_PORT` (the URL is authoritative).
 */
function resolveBaseUrl(configBaseUrl: string | undefined): string {
  if (configBaseUrl && configBaseUrl.length > 0) {
    return stripTrailingSlash(configBaseUrl);
  }
  const rawHost = (process.env.OLLAMA_HOST ?? '').trim();
  const rawPort = (process.env.OLLAMA_PORT ?? '').trim();
  if (rawHost.length === 0 && rawPort.length === 0) {
    return DEFAULT_OLLAMA_HOST;
  }
  if (rawHost.length > 0 && /^https?:\/\//i.test(rawHost)) {
    // Full URL form takes precedence — OLLAMA_PORT is intentionally
    // ignored so users can't end up with two conflicting sources of
    // truth.
    return stripTrailingSlash(rawHost);
  }
  const host = rawHost.length > 0 ? rawHost : 'localhost';
  const port = rawPort.length > 0 ? rawPort : String(DEFAULT_OLLAMA_PORT);
  return `http://${host}:${port}`;
}

interface IOllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}
