/**
 * Languages whose dedicated extractor does NOT emit call/reference edges
 * (`CallsSymbol` / `ReferencesSymbol`). Only the TS-family extractor
 * (`extractTsFile`, for ts/tsx/js/jsx) walks an AST to build the call graph;
 * the per-language extractors (Go, Python, Java, …) and the single-file
 * component / SDL formats produce symbol + import nodes but no reference edges.
 *
 * Consumers (`graph callers`, `code_find_usages`) use this to tell an agent
 * that an EMPTY caller list for a symbol in one of these files means
 * "not tracked", not "nothing calls it" — so it doesn't read silence as proof.
 */
const NON_CALL_GRAPH_LANGUAGES: ReadonlySet<string> = new Set([
  'python',
  'go',
  'java',
  'rust',
  'kotlin',
  'ruby',
  'csharp',
  'elixir',
  'php',
  'dart',
  'swift',
  'vue',
  'svelte',
  'astro',
  'graphql',
]);

/** True when call/reference edges are extracted for this file language. */
export function hasCallGraphReferences(language: string | undefined): boolean {
  return !language || !NON_CALL_GRAPH_LANGUAGES.has(language);
}
