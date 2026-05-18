/**
 * Approximate token count. Average English token ≈ 4 chars.
 * Good enough for a v1 budget gate; not a substitute for a real tokenizer.
 */
export declare function estimateTokens(text: string): number;
export declare function fitsBudget(currentTokens: number, addTokens: number, max: number): boolean;
//# sourceMappingURL=token-estimator.d.ts.map