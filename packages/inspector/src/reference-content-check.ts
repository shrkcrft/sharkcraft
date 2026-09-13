/**
 * Content assertions on a declared reference: `contains` / `matches` (read the
 * target's text) and `count` (re-derive a number the asset claims).
 *
 * Existence is the weakest proxy for what an asset claims — a file survives a
 * rename-inside refactor untouched while every statement about its contents
 * goes false. These turn prose claims into checks WITHOUT a new parser:
 *
 *   - `contains` / `matches` read the file (or the pinned symbol's declaration
 *     span), zoned through the ONE lexical-zone authority (`blankOutsideZone`),
 *     so `scan: 'code'` means here exactly what it means on the policy plane;
 *   - `count` is measured by the ONE extraction authority (`inspectSource`), so
 *     it gets every extractor, glob and zone the gate planes have.
 *
 * Every result reports what was found beside what was expected, so the fix is a
 * one-token edit.
 */
import { readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { blankOutsideZone, inspectSource } from '@shrkcrft/boundaries';
import { validateWiringSource, type IAssetReference, type IWiringSource } from '@shrkcrft/core';
import { ReferenceFailure } from './reference-failure.ts';

/** The outcome of one content or count assertion. */
export interface IReferenceAssertionResult {
  readonly ok: boolean;
  /** True when the assertion could not be evaluated at all — nothing was proved. */
  readonly unverifiable?: boolean;
  readonly failure?: ReferenceFailure;
  readonly expected?: string | number;
  readonly actual?: string | number;
  readonly message: string;
}

const SHOWN_LITERAL = 60;

function shown(s: string): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > SHOWN_LITERAL ? `${one.slice(0, SHOWN_LITERAL)}…` : one;
}

function unverifiable(message: string): IReferenceAssertionResult {
  return { ok: false, unverifiable: true, failure: ReferenceFailure.Unverifiable, message };
}

/** Whether `ref` carries a `contains` / `matches` assertion. */
export function hasContentAssertion(ref: IAssetReference): boolean {
  return ref.contains !== undefined || ref.matches !== undefined;
}

/**
 * Check `ref.contains` / `ref.matches` against its target. `span` narrows the
 * read to a pinned symbol's declaration. Returns `null` when the reference
 * carries no content assertion.
 */
export function checkReferenceContent(
  projectRoot: string,
  ref: IAssetReference,
  span?: { start: number; end: number },
): IReferenceAssertionResult | null {
  if (!hasContentAssertion(ref)) return null;
  if (!ref.path) return unverifiable('contains/matches needs a `path` to read — pin the file.');
  const abs = nodePath.join(projectRoot, ref.path);
  let text: string;
  try {
    if (statSync(abs).isDirectory()) {
      return unverifiable(`contains/matches cannot read a directory (${ref.path}) — assert on it with \`count\`.`);
    }
    text = readFileSync(abs, 'utf8');
  } catch {
    return unverifiable(`could not read ${ref.path}.`);
  }
  const zone = ref.scan ?? 'all';
  // Zone the WHOLE file, then slice: lexing from mid-declaration could start
  // inside a string and invert every zone after it.
  const zoned = blankOutsideZone(text, zone).content;
  const scoped = span ? zoned.slice(span.start, span.end) : zoned;
  const where = span && ref.symbol ? `the \`${ref.symbol}\` declaration in ${ref.path}` : ref.path;
  const zoneNote = zone === 'all' ? '' : ` (scan: ${zone})`;
  const held: string[] = [];
  if (ref.contains !== undefined) {
    if (!scoped.includes(ref.contains)) {
      return {
        ok: false,
        failure: ReferenceFailure.ContentMismatch,
        expected: `contains "${shown(ref.contains)}"`,
        actual: 'not found',
        message: `${where} no longer contains "${shown(ref.contains)}"${zoneNote}.`,
      };
    }
    held.push(`contains "${shown(ref.contains)}"`);
  }
  if (ref.matches !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(ref.matches, 'm');
    } catch (e) {
      return unverifiable(`matches /${ref.matches}/ does not compile: ${(e as Error).message}`);
    }
    if (!re.test(scoped)) {
      return {
        ok: false,
        failure: ReferenceFailure.ContentMismatch,
        expected: `matches /${ref.matches}/`,
        actual: 'no match',
        message: `${where} no longer matches /${ref.matches}/${zoneNote}.`,
      };
    }
    held.push(`matches /${ref.matches}/`);
  }
  return { ok: true, message: `${where} still ${held.join(' and ')}${zoneNote}.` };
}

/**
 * Re-derive `ref.count` through the extraction authority and compare it to the
 * claimed number. Returns `null` when the reference declares no count.
 *
 * A source that matched 0 files never measured anything, so it is unverifiable
 * — never a pass, even for `expected: 0`.
 */
export function checkReferenceCount(
  projectRoot: string,
  ref: IAssetReference,
  excludeDirs: readonly string[] = [],
): IReferenceAssertionResult | null {
  const count = ref.count;
  if (!count) return null;
  const source = count.source as IWiringSource | undefined;
  if (!source || typeof source !== 'object') return unverifiable('count.source is missing.');
  if (source.$use !== undefined) {
    return unverifiable('count.source uses `$use`, which a reference does not resolve — inline the selector.');
  }
  const problem = validateWiringSource(source);
  if (problem) return unverifiable(`count.source ${problem}.`);
  const res = inspectSource(projectRoot, source, excludeDirs);
  if (res.error) return unverifiable(`count.source could not be evaluated: ${res.error}`);
  if (res.filesScanned === 0) {
    return unverifiable(
      `count.source matched 0 files (${(source.files ?? []).join(', ')}) — the count was never measured` +
        (res.hint ? ` (${res.hint})` : '') +
        '.',
    );
  }
  const measure = count.measure ?? 'ids';
  const actual = measure === 'sites' ? res.sites.length : res.ids.length;
  const basis = `${measure} across ${res.filesScanned} file(s)`;
  if (actual === count.expected) {
    return {
      ok: true,
      expected: count.expected,
      actual,
      message: `count ${actual} = expected ${count.expected} (${basis}).`,
    };
  }
  return {
    ok: false,
    failure: ReferenceFailure.CountMismatch,
    expected: count.expected,
    actual,
    message: `count ${actual} ≠ expected ${count.expected} (${basis}) — set expected: ${actual}.`,
  };
}
