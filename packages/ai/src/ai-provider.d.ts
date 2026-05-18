import type { Result, AppError } from '@shrkcrft/core';
import type { IAiProviderConfig, IAiRequest, IAiResponse } from './ai-request.ts';
export interface IAiProvider {
    readonly id: string;
    readonly name: string;
    configure(config: IAiProviderConfig): void;
    isReady(): boolean;
    send(request: IAiRequest): Promise<Result<IAiResponse, AppError>>;
}
export declare abstract class AbstractAiProvider implements IAiProvider {
    abstract readonly id: string;
    abstract readonly name: string;
    protected config: IAiProviderConfig;
    configure(config: IAiProviderConfig): void;
    isReady(): boolean;
    abstract send(request: IAiRequest): Promise<Result<IAiResponse, AppError>>;
}
//# sourceMappingURL=ai-provider.d.ts.map