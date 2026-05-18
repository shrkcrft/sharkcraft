/**
 * Approximate token count. Average English token ≈ 4 chars.
 * Good enough for a v1 budget gate; not a substitute for a real tokenizer.
 */
export function estimateTokens(text) {
    if (!text)
        return 0;
    // Use a slightly conservative ratio so we stay under budget.
    const chars = text.length;
    const words = text.trim().split(/\s+/).length;
    return Math.max(Math.ceil(chars / 4), Math.ceil(words * 1.3));
}
export function fitsBudget(currentTokens, addTokens, max) {
    return currentTokens + addTokens <= max;
}
