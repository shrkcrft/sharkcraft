/**
 * THE identifier tokenizer.
 *
 * Splits an identifier (or a free-text phrase) into lowercase tokens across
 * camelCase, PascalCase, acronym runs, snake_case, kebab-case, whitespace and
 * lower/digit→Upper boundaries:
 *
 *   DateRangePicker          → [date, range, picker]
 *   IDateRangePickerOptions  → [i, date, range, picker, options]
 *   HTTPServer               → [http, server]
 *   date_range-picker        → [date, range, picker]
 *
 * One splitter for every "does this name match these words?" question —
 * reuse name matching, spec evidence and the recommender's term matcher all
 * read it — so two callers can never disagree about where a word boundary is.
 * Do not write another. Order is preserved and duplicates are kept (callers
 * that need a set build one); empty fragments are dropped. No stop-word or
 * length filtering happens here — that is a caller's policy, not a boundary.
 */
export function splitIdentifierTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}
