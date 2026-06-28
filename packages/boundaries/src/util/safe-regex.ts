/**
 * Compile a user/pack-supplied regex without ever throwing. The `g` flag is
 * always applied (engines scan with `exec` loops); extra flags are merged and
 * de-duped. A bad pattern / bad flags returns a clear `error` string so callers
 * degrade a misconfigured rule to a diagnostic instead of crashing.
 */
export function safeCompile(pattern: string, flags?: string): { re?: RegExp; error?: string } {
  try {
    const f = [...new Set(['g', ...(flags ?? '').split('')].filter(Boolean))].join('');
    return { re: new RegExp(pattern, f) };
  } catch (e) {
    return { error: `invalid regex /${pattern}/${flags ?? ''}: ${(e as Error).message}` };
  }
}

/** Number of capture groups in a compiled regex (probe via an always-empty variant). */
export function countCaptureGroups(re: RegExp): number {
  try {
    return (new RegExp(re.source + '|').exec('')?.length ?? 1) - 1;
  } catch {
    return 1; // can't determine → assume valid
  }
}
