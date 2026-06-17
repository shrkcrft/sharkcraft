/**
 * Coarse content classes the router recognises. The class selects which
 * deterministic compressor runs. Ordered loosely from most-specific
 * (cheapest to over-trigger) to least.
 */
export enum EContentType {
  /** A JSON array (top-level `[ ... ]`). The table compactor's prime target. */
  JsonArray = 'json-array',
  /** A JSON object or scalar (top-level `{ ... }` / value). */
  Json = 'json',
  /** A unified/`git` diff. */
  GitDiff = 'git-diff',
  /** grep/ripgrep `file:line:` style search output. */
  SearchResults = 'search-results',
  /** Build / test / runtime log output. */
  BuildLog = 'build-log',
  /** Source code in a recognised language. */
  SourceCode = 'source-code',
  /** Markdown prose / docs. */
  Markdown = 'markdown',
  /** YAML configuration / manifests (`key: value` mappings + `- ` lists). */
  Yaml = 'yaml',
  /** Delimiter-separated values (CSV / TSV): a stable column count per line. */
  Csv = 'csv',
  /** Anything else. */
  PlainText = 'plain-text',
}
