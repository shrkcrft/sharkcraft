/**
 * One MARKED entry of a markable selector list (round 13): the unit — a glob,
 * or an import-specifier pattern — plus the assertion that its target does not
 * exist yet. A pre-emptive fence (`@scope/plugin-react` before the package is
 * created), a planned directory (`packages/plugin-react/**`), a layer root.
 *
 *   forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true }]
 *
 * - The unit is named in `pattern` on EVERY list, glob lists and import-pattern
 *   lists alike. A negation keeps its `!` inside `pattern`.
 * - `expectEmpty` is the literal `true`. Anything else is refused at load: the
 *   plain string already says "expect this to be live".
 * - `reason` is optional prose, printed next to the unit's state.
 *
 * The shape is EXACT — any other key is refused (with a did-you-mean), and in
 * particular `packageName`, which a loader STAMPS from pack provenance
 * (`stampUnitMarks`). `normalizeUnitList` / `normalizeUnitScalar` are the one
 * parser; a loaded list never contains an object.
 */
export interface IExpectEmptyEntry {
  readonly pattern: string;
  readonly expectEmpty: true;
  readonly reason?: string;
}
