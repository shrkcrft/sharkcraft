import type { TaskIntent } from '../schema/context-pack.ts';

/**
 * Deterministic, keyword-based task intent classifier.
 *
 * No embedded model. Maps free-text task strings to an intent label so
 * the ranker can tune its weights. Conflicts resolve in priority order:
 *   release > migration > bug-fix > refactor > docs > feature
 *
 * `unknown` is returned when no keyword matches — the ranker then uses
 * its neutral baseline weights.
 */
export function classifyIntent(task: string): TaskIntent {
  if (typeof task !== 'string') return 'unknown';
  const t = task.toLowerCase();
  if (matchAny(t, ['release', 'cut release', 'publish', 'preflight', 'tag '])) return 'release';
  if (matchAny(t, ['migration', 'migrate', 'upgrade', 'deprecat'])) return 'migration';
  if (matchAny(t, ['bug', 'fix', 'error', 'broken', 'regression', 'crash', 'throws', 'fails'])) return 'bug-fix';
  if (matchAny(t, ['refactor', 'cleanup', 'simplify', 'extract', 'rename', 'move'])) return 'refactor';
  if (matchAny(t, ['docs', 'document', 'readme', 'guide', 'tutorial', 'explain'])) return 'docs';
  if (
    matchAny(t, [
      'add ',
      'create ',
      'implement',
      'feature',
      'support for',
      'enable ',
      'introduce',
      'new ',
    ])
  ) return 'feature';
  return 'unknown';
}

function matchAny(t: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (t.includes(n)) return true;
  }
  return false;
}
