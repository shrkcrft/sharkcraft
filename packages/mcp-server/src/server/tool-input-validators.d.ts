import { z } from 'zod';
export declare const TOOL_INPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>>;
export interface IToolValidationFailure {
    toolName: string;
    message: string;
    issues: {
        path: string;
        message: string;
    }[];
}
export declare function validateToolInput(toolName: string, input: unknown): {
    ok: true;
    data: unknown;
} | {
    ok: false;
    failure: IToolValidationFailure;
};
//# sourceMappingURL=tool-input-validators.d.ts.map