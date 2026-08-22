/**
 * Select the KEYS of a baseline's entries out of a JSON document.
 *
 * `keyBy` turns a blob comparison into a keyed-set comparison: the diff then
 * names which entry appeared or vanished instead of which line moved, so a
 * reformat is not drift and a real deletion cannot hide inside one.
 */
import type { IWiringSource } from '@shrkcrft/core';
import { extractTokens } from '../extract/extract-tokens.ts';

/**
 * Extract every id `jsonPath` selects from `text` (JSON only — a hand-rolled
 * YAML reader would be a silent-wrong-answer risk). Non-JSON text yields no
 * keys, which the caller reports as an empty side rather than a false match.
 *
 * Delegates to the shared extraction DSL so `keyBy` and a wiring rule's
 * `json-path` source resolve paths identically.
 */
export function extractJsonPath(text: string, jsonPath: string): string[] {
  const source: IWiringSource = { files: ['<inline>'], extract: 'json-path', jsonPath };
  return extractTokens(source, [{ path: '<inline>', content: text }]).sites.map((s) => s.token);
}
