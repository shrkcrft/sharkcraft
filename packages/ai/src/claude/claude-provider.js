import { AppErrorImpl, ERROR_CODES, err, ok } from '@shrkcrft/core';
import { AbstractAiProvider } from "../ai-provider.js";
/**
 * Reference HTTP adapter for Anthropic's Claude Messages API.
 * Kept dependency-free: uses fetch() directly. If ANTHROPIC_API_KEY is missing,
 * isReady() returns false and send() reports an actionable error.
 */
export class ClaudeProvider extends AbstractAiProvider {
    id = 'claude';
    name = 'Anthropic Claude (HTTP)';
    isReady() {
        return Boolean(this.config.apiKey ?? process.env.ANTHROPIC_API_KEY);
    }
    async send(request) {
        const apiKey = this.config.apiKey ?? process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            return err(new AppErrorImpl(ERROR_CODES.INVALID_INPUT, 'ANTHROPIC_API_KEY is not set — cannot reach Claude', { suggestion: 'export ANTHROPIC_API_KEY=...' }));
        }
        const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com';
        const model = request.model ?? this.config.model ?? 'claude-sonnet-4-6';
        const maxTokens = request.maxTokens ?? 1024;
        const messages = request.messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content }));
        const system = request.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n') || undefined;
        try {
            const res = await fetch(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({ model, max_tokens: maxTokens, messages, system }),
            });
            if (!res.ok) {
                const text = await res.text();
                return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, `Claude API ${res.status}: ${text.slice(0, 500)}`));
            }
            const json = (await res.json());
            const text = (json.content ?? [])
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text)
                .join('');
            return ok({
                content: text,
                model: json.model ?? model,
                finishReason: json.stop_reason,
                usage: {
                    inputTokens: json.usage?.input_tokens,
                    outputTokens: json.usage?.output_tokens,
                },
                raw: json,
            });
        }
        catch (e) {
            return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, `Failed to call Claude: ${e.message}`, {
                cause: e,
            }));
        }
    }
}
