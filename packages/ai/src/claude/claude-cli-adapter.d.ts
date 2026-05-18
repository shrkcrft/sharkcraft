import { type AppError, type Result } from '@shrkcrft/core';
import { AbstractAiProvider } from '../ai-provider.ts';
import type { IAiRequest, IAiResponse } from '../ai-request.ts';
/**
 * Optional adapter that shells out to a local `claude` CLI binary.
 * It assumes the binary supports `--print --output-format=text`. If it does not,
 * isReady() returns false and send() returns an actionable error.
 */
export declare class ClaudeCliAdapter extends AbstractAiProvider {
    readonly id = "claude-cli";
    readonly name = "Claude (local CLI)";
    private cliPath;
    constructor(cliPath?: string);
    isReady(): boolean;
    send(request: IAiRequest): Promise<Result<IAiResponse, AppError>>;
}
//# sourceMappingURL=claude-cli-adapter.d.ts.map