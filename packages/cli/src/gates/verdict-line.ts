import { ExitCode } from '../exit-codes.ts';
import type { ISettledVerdict } from './settled-verdict.ts';

/** Shortfalls named on the verdict line before the rest are summarised. */
const SHORTFALLS_SHOWN = 5;

/**
 * The final line of a verdict verb, rendered FROM the settled verdict — the
 * only way a verb may print its clean (`✓`) sentence.
 *
 *   - exit `0`: `clean`, followed by one indented line per accepted gap, so a
 *     waived shortfall is always visible next to the green;
 *   - exit `2`: `notVerifiedLead` (the verb's own explanation, when it has one)
 *     and then `NOT VERIFIED: <shortfalls> (this is not a pass)`;
 *   - exit `1`: `(also not verified: <shortfalls>)` when a scope gap sits next
 *     to the violations, otherwise empty — the verb already printed them;
 *   - anything else: empty.
 *
 * It never returns `clean` for a non-zero exit, which is the property that
 * keeps the banner and `$?` from disagreeing.
 */
export function verdictLine(s: ISettledVerdict, clean: string, notVerifiedLead?: string): string {
  if (s.exit === ExitCode.VerifiedPass) {
    return [clean, ...s.accepted.map((a) => `  ${a}`)].filter((l) => l.length > 0).join('\n');
  }
  const listed = listShortfalls(s.shortfalls);
  if (s.exit === ExitCode.NotVerified) {
    if (s.shortfalls.length === 0) {
      return notVerifiedLead ?? 'NOT VERIFIED — nothing was proved (this is not a pass).';
    }
    const line = `NOT VERIFIED: ${listed} (this is not a pass)`;
    return notVerifiedLead ? `${notVerifiedLead}\n${line}` : line;
  }
  if (s.exit === ExitCode.Failure && s.shortfalls.length > 0) {
    return `(also not verified: ${listed})`;
  }
  return '';
}

function listShortfalls(shortfalls: readonly string[]): string {
  const shown = shortfalls.slice(0, SHORTFALLS_SHOWN).join('; ');
  const rest = shortfalls.length - SHORTFALLS_SHOWN;
  return rest > 0 ? `${shown}; … (+${rest} more)` : shown;
}
