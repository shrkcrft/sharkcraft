import type { SymbolMemberKind } from './symbol-member-kind.ts';

/**
 * One member of a top-level declaration: a class method / property / accessor,
 * an interface member, an enum member, a namespace declaration, or a key of a
 * `const x = { … }` object literal.
 *
 * The symbol index used to walk top-level statements only, so a reference to a
 * method that plainly exists reported "not declared" forever and the only
 * escape was coarsening it to the whole file — losing exactly the precision a
 * symbol reference exists for. Members make `Owner.member` addressable.
 */
export interface ISymbolMemberEntry {
  /** The enclosing top-level declaration's name (`Foo` for `Foo.bar`). */
  owner: string;
  name: string;
  kind: SymbolMemberKind;
  /** True for a `static` class member. */
  static: boolean;
  /** Line (1-based) where the member starts. */
  line: number;
  /** Character offset of the member's first token. */
  start: number;
  /** Character offset just past the member's last token. */
  end: number;
}
