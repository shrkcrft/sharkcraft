export interface IStructuralMatch {
  /** Project-relative POSIX path. */
  file: string;
  /** 1-based line number of the matched node start. */
  line: number;
  /** 0-based column number of the matched node start. */
  column: number;
  /** AST node kind name (e.g. 'CallExpression'). */
  nodeKind: string;
  /** First ~140 chars of the matched text, single-lined. */
  excerpt: string;
}

export interface IStructuralSearchResult {
  schema: 'sharkcraft.structural-search/v1';
  pattern: { kind: string; summary: string };
  filesScanned: number;
  matchCount: number;
  truncated: boolean;
  matches: readonly IStructuralMatch[];
  diagnostics: readonly string[];
}
