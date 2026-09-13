/**
 * `spec.md` split: the `---` delimiters, the frontmatter document and the
 * Markdown body.
 *
 * The frontmatter PARSER is `@shrkcrft/core`'s `parseFrontmatter` — THE
 * indentation-aware, Result-returning reader of the `sharkcraft.spec/v1`
 * subset (round 15: moved down from here so the Markdown knowledge loader reads
 * frontmatter through the same authority as `spec.md`). It, `parseInlineScalar`
 * and the value types are re-exported so every generator / CLI import stays
 * unchanged — there is no second implementation.
 *
 * Pure. No IO.
 */

import {
  AppErrorImpl,
  ERROR_CODES,
  err,
  ok,
  parseFrontmatter,
  type AppError,
  type FrontmatterValue,
  type Result,
} from '@shrkcrft/core';

export { parseFrontmatter, parseInlineScalar } from '@shrkcrft/core';
export type { FrontmatterFieldValue, FrontmatterScalar, FrontmatterValue } from '@shrkcrft/core';

export interface IFrontmatterDocument {
  readonly fields: Readonly<Record<string, FrontmatterValue>>;
  /** Original frontmatter text (between the `---` delimiters), for hashing. */
  readonly raw: string;
}

export interface IParsedSpecMd {
  readonly frontmatter: IFrontmatterDocument;
  /** Markdown body (everything after the closing `---`). */
  readonly body: string;
}

const FRONTMATTER_DELIMITER = '---';

export function splitSpecMd(source: string): Result<IParsedSpecMd, AppError> {
  const lines = source.split('\n');
  if (lines.length === 0 || lines[0]!.trim() !== FRONTMATTER_DELIMITER) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        'spec.md must begin with `---` on its first line',
      ),
    );
  }
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FRONTMATTER_DELIMITER) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.INVALID_INPUT,
        'spec.md frontmatter not terminated (missing closing `---`)',
      ),
    );
  }
  const frontmatterLines = lines.slice(1, closeIdx);
  const raw = frontmatterLines.join('\n');
  const parsed = parseFrontmatter(raw);
  if (!parsed.ok) return err(parsed.error);
  const body = lines.slice(closeIdx + 1).join('\n');
  return ok({
    frontmatter: { fields: parsed.value, raw },
    body,
  });
}
