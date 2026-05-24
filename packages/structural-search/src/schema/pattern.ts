/**
 * Declarative AST pattern DSL. Patterns describe an AST *shape*; the
 * matcher walks the tree and emits a match per matching node. There are
 * deliberately no executable predicates — patterns serialise as plain
 * JSON, sign cleanly, and never run user JS in the matcher.
 *
 * Schema: sharkcraft.structural-pattern/v1.
 *
 * Supported kinds in Wave 4 (foundation):
 *   - CallExpression
 *   - NewExpression
 *   - ImportDeclaration
 *   - ClassDeclaration
 *   - Decorator
 *   - Identifier
 *   - StringLiteral
 *
 * Additional kinds (function/method declarations, JSX, conditional types,
 * etc.) slot in by adding a new variant to `StructuralPattern` plus a
 * branch in `matchPattern`.
 */
export const STRUCTURAL_PATTERN_SCHEMA = 'sharkcraft.structural-pattern/v1' as const;

export type StructuralPattern =
  | ICallExpressionPattern
  | INewExpressionPattern
  | IImportDeclarationPattern
  | IClassDeclarationPattern
  | IDecoratorPattern
  | IIdentifierPattern
  | IStringLiteralPattern;

export interface IPatternEnvelope {
  schema: typeof STRUCTURAL_PATTERN_SCHEMA;
  id?: string;
  title?: string;
  description?: string;
  pattern: StructuralPattern;
}

// ── Leaf patterns ──────────────────────────────────────────────────────

export interface IIdentifierPattern {
  kind: 'Identifier';
  /** Exact-match name. `*` matches any identifier. */
  name?: string;
  /** ECMAScript regex source (without flags). Matched against the identifier text. */
  nameRegex?: string;
}

export interface IStringLiteralPattern {
  kind: 'StringLiteral';
  /** Exact match. */
  text?: string;
  textRegex?: string;
}

// ── Container patterns ─────────────────────────────────────────────────

export interface ICallExpressionPattern {
  kind: 'CallExpression';
  /** Match against the callee identifier name. */
  callee?: IIdentifierPattern;
  /** Optional minimum argument count. */
  minArgs?: number;
  /** Optional exact argument count. */
  argCount?: number;
}

export interface INewExpressionPattern {
  kind: 'NewExpression';
  callee?: IIdentifierPattern;
}

export interface IImportDeclarationPattern {
  kind: 'ImportDeclaration';
  /** Exact specifier match. */
  from?: string;
  fromRegex?: string;
  /** True → match only side-effect imports `import "x";`. */
  sideEffectOnly?: boolean;
  /** Match only when this named import exists. */
  importedName?: string;
}

export interface IClassDeclarationPattern {
  kind: 'ClassDeclaration';
  name?: string;
  nameRegex?: string;
  /** Require a decorator with this identifier name. */
  hasDecoratorNamed?: string;
}

export interface IDecoratorPattern {
  kind: 'Decorator';
  /** Decorator identifier name (e.g. `Controller`). */
  name?: string;
  /**
   * Match only when the decorator is invoked as a call expression
   * `@Foo(...)` (true) vs a bare identifier `@Foo` (false). Omit to
   * accept either.
   */
  isCall?: boolean;
}
