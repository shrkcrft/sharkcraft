import type { EVolatileKind } from './volatile-kind.ts';

/** One original-value ↔ placeholder binding. */
export interface IAlignmentBinding {
  /** `«vk:uuid:0001»`. */
  placeholder: string;
  /** The cleaned original token (no surrounding quotes/punctuation). */
  original: string;
  kind: EVolatileKind;
  /** Per-kind ordinal (first-appearance order). */
  ordinal: number;
}

/**
 * The reversible alignment map. Append-only, first-appearance order, plain JSON
 * so it serialises for the CLI and travels in MCP tool I/O. Carry it across
 * turns so a value keeps its placeholder — that carry-forward is what stabilises
 * the cache prefix. Per-kind next ordinal is `1 + max(ordinal of that kind)`,
 * a pure function of `bindings` (no hidden counter).
 */
export interface IAlignmentMap {
  version: 1;
  bindings: IAlignmentBinding[];
}
