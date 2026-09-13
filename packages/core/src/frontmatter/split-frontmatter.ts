/**
 * THE frontmatter delimiter split (round 15 follow-up, F6): where a Markdown
 * document's `---` frontmatter starts and ends, for readers that hand the block
 * to {@link parseFrontmatter}. Decision records and Cursor `.mdc` rules read
 * through it (their ad-hoc splitters disagreed: one needed `---\n` exactly and
 * missed a CRLF or a `--- ` file, the other opened on any line STARTING with
 * `---` and closed on `---x`).
 *
 *   - A UTF-8 BOM is dropped and CRLF / CR line ends become `\n` first.
 *   - The first line, trailing whitespace ignored, must be `---`; the block ends
 *     at the next line that is `---` (trailing whitespace ignored) — at column
 *     0, so an indented `---` inside a block scalar never closes it.
 *   - No closing line: no frontmatter, the whole document is the body, and
 *     `unterminated` says so.
 *
 * Pure. No IO.
 */
import type { IFrontmatterSplit } from './i-frontmatter-split.ts';

const DELIMITER = '---';

export function splitFrontmatter(source: string): IFrontmatterSplit {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trimEnd() !== DELIMITER) {
    return { frontmatter: undefined, body: text, lineOffset: 0, unterminated: false };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === DELIMITER) {
      return {
        frontmatter: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
        lineOffset: 1,
        unterminated: false,
      };
    }
  }
  return { frontmatter: undefined, body: text, lineOffset: 0, unterminated: true };
}
