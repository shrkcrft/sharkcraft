import { type AppError, type Result } from '@shrkcrft/core';
import { AbstractAiProvider } from '../ai-provider.ts';
import type { IAiRequest, IAiResponse } from '../ai-request.ts';
/**
 * Reference HTTP adapter for Anthropic's Claude Messages API.
 * Kept dependency-free: uses fetch() directly. If ANTHROPIC_API_KEY is missing,
 * isReady() returns false and send() reports an actionable error.
 */
export declare class ClaudeProvider extends AbstractAiProvider {
    readonly id = "claude";
    readonly name = "Anthropic Claude (HTTP)";
    isReady(): boolean;
    send(request: IAiRequest): Promise<Result<IAiResponse, AppError>>;
}
//# sourceMappingURL=claude-provider.d.ts.map