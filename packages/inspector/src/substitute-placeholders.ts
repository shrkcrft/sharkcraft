/**
 * THE `{{var}}` placeholder substitution for declarative snippets — used by
 * registration-hint previews and pack-helper plans. An unknown placeholder is
 * left verbatim (never blanked), so a missing variable is visible in the
 * rendered snippet instead of silently producing an empty string.
 */
export function substitutePlaceholders(snippet: string, vars: Readonly<Record<string, string>>): string {
  return snippet.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_m, key: string) =>
    vars[key] !== undefined ? vars[key]! : `{{${key}}}`,
  );
}
