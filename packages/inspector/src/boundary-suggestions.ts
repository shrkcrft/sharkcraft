import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export interface IBoundaryFixSuggestion {
  ruleId: string;
  file: string;
  line: number;
  importSpecifier: string;
  suggestions: readonly string[];
  relatedRule?: string;
  relatedPathConvention?: string;
}

export interface IBoundaryViolationInput {
  ruleId: string;
  file: string;
  line: number;
  importSpecifier: string;
  /** Already-known suggestedFix from boundary rule, if any. */
  suggestedFix?: string;
}

export function suggestBoundaryFixes(
  inspection: ISharkcraftInspection,
  violations: readonly IBoundaryViolationInput[],
): IBoundaryFixSuggestion[] {
  const out: IBoundaryFixSuggestion[] = [];
  const paths = inspection.pathService.list();
  const rules = inspection.ruleService.list();
  for (const v of violations) {
    const suggestions: string[] = [];
    if (v.suggestedFix) suggestions.push(v.suggestedFix);

    // 1) Suggest the package's public entrypoint if the import dives into internals.
    if (v.importSpecifier.startsWith('@') && v.importSpecifier.includes('/src/')) {
      suggestions.push(
        `Import from the package's public entrypoint instead of a deep ${v.importSpecifier} path.`,
      );
    }
    if (v.importSpecifier.includes('/dist/')) {
      suggestions.push(`Avoid importing from /dist/; import the package by name.`);
    }
    if (v.importSpecifier.startsWith('../') && v.file.includes('/packages/')) {
      suggestions.push(
        `Use the absolute package name ("@shrkcrft/<package>") instead of a relative ${v.importSpecifier} across package boundaries.`,
      );
    }

    // 2) Adapter / layer fix hints based on common segments.
    if (/\/adapter[s]?\//.test(v.file)) {
      suggestions.push(
        'Adapter files should depend on contracts only; introduce or use an interface in the adjacent contract package.',
      );
    }

    // 3) Move-file suggestion when target file appears mis-located.
    if (/\/(ui|dashboard|web)\//.test(v.file) && /\/(server|api|core)\//.test(v.importSpecifier)) {
      suggestions.push(
        'UI code should not import server/core directly — consider exposing an API client interface and moving this consumer to a shared adapter.',
      );
    }

    // 4) Path-convention hint.
    const path = paths.find((p) => v.file.includes(p.id) || v.file.includes(p.title));
    if (path) {
      suggestions.push(
        `Path convention "${path.id}" applies — check ${path.title} for the canonical location.`,
      );
    }

    // 5) Related rule lookup.
    const relatedRule = rules.find((r) => r.id === v.ruleId);

    const item: IBoundaryFixSuggestion = {
      ruleId: v.ruleId,
      file: v.file,
      line: v.line,
      importSpecifier: v.importSpecifier,
      suggestions: dedup(suggestions),
    };
    if (relatedRule) item.relatedRule = relatedRule.id;
    if (path) item.relatedPathConvention = path.id;
    out.push(item);
  }
  return out;
}

function dedup(xs: readonly string[]): string[] {
  return [...new Set(xs.filter((s) => s && s.trim().length > 0))];
}
