import type { FrontmatterScalar } from './frontmatter-scalar.ts';

/** A value inside a frontmatter map: a scalar, a scalar list, or a one-level map of scalars. */
export type FrontmatterFieldValue =
  | FrontmatterScalar
  | readonly FrontmatterScalar[]
  | Readonly<Record<string, FrontmatterScalar>>;
