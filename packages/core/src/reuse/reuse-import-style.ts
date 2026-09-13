/**
 * How a reuse answer's copy-paste import binds its symbol.
 *
 * - `named`   — `import { X } from '<specifier>'`.
 * - `default` — `import X from '<specifier>'`: the module's DEFAULT export
 *   (a named import of it would not compile).
 *
 * Decided once, from the module's real export surface, so the printed import
 * line and `shrk reuse coverage`'s "would this import compile?" check can never
 * disagree.
 */
export enum ReuseImportStyle {
  Named = 'named',
  Default = 'default',
}
