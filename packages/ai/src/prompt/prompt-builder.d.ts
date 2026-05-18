import { type IAiMessage } from '../ai-request.ts';
export interface BuildPromptInput {
    systemPreamble?: string;
    context?: string;
    task: string;
    userMessage?: string;
}
export declare function buildPromptMessages(input: BuildPromptInput): IAiMessage[];
//# sourceMappingURL=prompt-builder.d.ts.map