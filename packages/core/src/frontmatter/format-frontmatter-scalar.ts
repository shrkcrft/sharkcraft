/**
 * THE inverse of {@link parseFrontmatter} for one string value (round 15
 * follow-up, F6): the text a writer puts after `key: ` so the parser — under
 * the same {@link IParseFrontmatterOptions.scalars} mode — reads back exactly
 * `value`. Bare when the bare text already reads back as itself (decided by
 * THE parser, not a second opinion); otherwise double-quoted with the escapes
 * the parser undoes (`\\`, `\"`, `\n`, `\t`).
 *
 * `previewDecisionDraft` wrote `title: ${title}` raw, so a title such as
 * `[WIP]` or `"Quoted"` did not read back as written.
 *
 * Pure. No IO.
 */
import type { IParseFrontmatterOptions } from './i-parse-frontmatter-options.ts';
import { parseFrontmatter } from './parse-frontmatter.ts';

export function formatFrontmatterScalar(value: string, options: IParseFrontmatterOptions = {}): string {
  const bare = parseFrontmatter(`v: ${value}`, { scalars: options.scalars });
  if (bare.ok && bare.value['v'] === value) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}
