import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import { AbstractAiProvider } from '../ai-provider.ts';
import { AiMessageRole, type IAiMessage, type IAiRequest, type IAiResponse } from '../ai-request.ts';

/**
 * HTTP adapter for Google's Gemini (Generative Language API).
 *
 * Reads `GEMINI_API_KEY` from env (or `IAiProviderConfig.apiKey`). When
 * the key is missing `isReady()` returns false and `send()` reports an
 * actionable error — same contract as `ClaudeProvider`.
 *
 * The Gemini REST surface differs from Anthropic's: system messages are
 * passed as a top-level `systemInstruction`, conversation turns become
 * `contents[]` with roles `user`/`model`, and the response token cap is
 * `generationConfig.maxOutputTokens` (not `max_tokens`). This adapter
 * translates the provider-neutral `IAiRequest` shape into that wire
 * format and back.
 */
export class GeminiProvider extends AbstractAiProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini (HTTP)';

  isReady(): boolean {
    return Boolean(this.config.apiKey ?? process.env.GEMINI_API_KEY);
  }

  async send(request: IAiRequest): Promise<Result<IAiResponse, AppError>> {
    const apiKey = this.config.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.INVALID_INPUT,
          'GEMINI_API_KEY is not set — cannot reach Gemini',
          { suggestion: 'Put GEMINI_API_KEY=... in .env or `export GEMINI_API_KEY=...`' },
        ),
      );
    }

    const baseUrl = this.config.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const model = request.model ?? this.config.model ?? 'gemini-2.5-flash';
    const maxTokens = request.maxTokens ?? 4096;

    const systemInstructionText = collectSystem(request.messages);
    const contents = collectContents(request.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseFormat
          ? {
              responseMimeType: 'application/json',
            }
          : {}),
      },
    };
    if (systemInstructionText) {
      body.systemInstruction = { role: 'system', parts: [{ text: systemInstructionText }] };
    }

    try {
      const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        return err(
          new AppErrorImpl(
            ERROR_CODES.IO_ERROR,
            `Gemini API ${res.status}: ${text.slice(0, 500)}`,
          ),
        );
      }
      const json = (await res.json()) as IGeminiResponse;
      const content = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('');
      return ok({
        content,
        model: json.modelVersion ?? model,
        finishReason: json.candidates?.[0]?.finishReason,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount,
          outputTokens: json.usageMetadata?.candidatesTokenCount,
        },
        raw: json,
      });
    } catch (e) {
      return err(
        new AppErrorImpl(ERROR_CODES.IO_ERROR, `Failed to call Gemini: ${(e as Error).message}`, {
          cause: e,
        }),
      );
    }
  }
}

function collectSystem(messages: readonly IAiMessage[]): string | undefined {
  const parts = messages.filter((m) => m.role === AiMessageRole.System).map((m) => m.content);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

function collectContents(messages: readonly IAiMessage[]): IGeminiContent[] {
  const out: IGeminiContent[] = [];
  for (const m of messages) {
    if (m.role === AiMessageRole.System) continue;
    out.push({
      role: m.role === AiMessageRole.Assistant ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }
  return out;
}

interface IGeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface IGeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}
