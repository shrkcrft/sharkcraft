import type { FrontmatterFieldValue } from './frontmatter-field-value.ts';
import type { FrontmatterScalar } from './frontmatter-scalar.ts';

/** A top-level frontmatter value: a scalar, a scalar list, a list of maps, or a map. */
export type FrontmatterValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[]
  | ReadonlyArray<Readonly<Record<string, FrontmatterFieldValue>>>
  | Readonly<Record<string, FrontmatterFieldValue>>;
