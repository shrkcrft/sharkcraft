/**
 * The closed set of area kinds a repository file can be classified into.
 *
 * It lives in core, not next to the area-map classifier in the inspector, so
 * the config schema (a lower layer) can validate a project's
 * `areaMap.patterns[].kind` against the real enum. Keeping two copies in step
 * by hand is exactly the bug class this repo keeps paying for.
 *
 * `Unknown` is what a file with no matching pattern gets. A project pattern may
 * never declare it: "unclassified" is an outcome, not a classification.
 */
export enum AreaKind {
  Core = 'core',
  Ui = 'ui',
  App = 'app',
  Api = 'api',
  Tests = 'tests',
  Docs = 'docs',
  Infra = 'infra',
  Generated = 'generated',
  Unknown = 'unknown',
}
