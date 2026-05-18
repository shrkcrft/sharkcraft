/**
 * Polyglot boundary enforcement.
 *
 * Evaluates built-in per-language boundary rules against the polyglot
 * dependency scan and reports violations + suggested fixes. Pure
 * file/regex-driven, no compiler integration.
 *
 * The existing TypeScript boundary engine is unchanged. This report is a
 * cross-cutting view used by `shrk boundaries enforce --language ...`,
 * `shrk check boundaries --polyglot`, and `get_polyglot_boundary_report`.
 */
import { LanguageId } from './language-id.ts';
import { detectLanguageProfiles, type ILanguageProfileReport } from './language-detection.ts';
import { scanPolyglotDependencies, type IPolyglotDependencyGraph, type IPolyglotImportEdge } from './dependency-scan.ts';

export const POLYGLOT_BOUNDARY_REPORT_SCHEMA = 'sharkcraft.polyglot-boundary-report/v1';

export type PolyglotBoundarySeverity = 'error' | 'warning';

export interface IPolyglotBoundaryRule {
  id: string;
  title: string;
  language: LanguageId;
  severity: PolyglotBoundarySeverity;
  /** Anchored regex that matches a project-relative `from` file path. */
  fromPattern: RegExp;
  /** Regex that matches a forbidden import target (namespace / module / package). */
  forbiddenTargetPattern: RegExp;
  /** Optional `to` file-path pattern when both ends live in the repo (internal edges). */
  toPattern?: RegExp;
  /** Short rationale used by reports and contract enforcement. */
  reason: string;
  /** Suggested fix (one-line). */
  suggestedFix: string;
}

export interface IPolyglotBoundaryViolation {
  ruleId: string;
  language: LanguageId;
  severity: PolyglotBoundarySeverity;
  fromFile: string;
  importSpecifier: string;
  toFile?: string;
  reason: string;
  suggestedFix: string;
  /** confidence based on the underlying dep scan + match strength. */
  confidence: 'high' | 'medium' | 'low';
}

export interface IPolyglotBoundaryReport {
  schema: typeof POLYGLOT_BOUNDARY_REPORT_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  /** Languages actually evaluated (filtered by --language). */
  languages: readonly LanguageId[];
  rules: readonly IPolyglotBoundaryRule[];
  edges: readonly IPolyglotImportEdge[];
  violations: readonly IPolyglotBoundaryViolation[];
  counts: {
    rules: number;
    edges: number;
    violations: number;
    errors: number;
    warnings: number;
  };
  limitations: readonly string[];
  suggestedFixes: readonly string[];
}

export interface IBuildPolyglotBoundaryReportOptions {
  projectRoot: string;
  /** Restrict evaluation to these languages; default: all detected polyglot languages. */
  languages?: readonly LanguageId[];
  /** Reuse a cached profile report. */
  cached?: ILanguageProfileReport;
  /** Optional pre-computed dependency graph. */
  graph?: IPolyglotDependencyGraph;
  /** Cap total violations rendered. Default 200. */
  limit?: number;
}

const JAVA_RULES: readonly IPolyglotBoundaryRule[] = [
  {
    id: 'java.domain.no-spring-web',
    title: 'Domain must not depend on Spring Web',
    language: LanguageId.Java,
    severity: 'error',
    fromPattern: /(^|\/)domain\//i,
    forbiddenTargetPattern: /^org\.springframework\.web\./,
    reason: 'Domain stays framework-agnostic; routing concerns belong in the web/controller layer.',
    suggestedFix: 'Move web-binding to a controller and expose a service interface in domain.',
  },
  {
    id: 'java.controller.no-repository-direct',
    title: 'Controllers should not import repositories directly',
    language: LanguageId.Java,
    severity: 'warning',
    fromPattern: /(^|\/)controller\//i,
    forbiddenTargetPattern: /\.(repository|dao)\./i,
    reason: 'Controllers should call services; persistence is an internal concern.',
    suggestedFix: 'Inject a service that wraps the repository instead.',
  },
  {
    id: 'java.main.no-test-import',
    title: 'Production code must not import the test tree',
    language: LanguageId.Java,
    severity: 'error',
    fromPattern: /(^|\/)src\/main\/java\//,
    forbiddenTargetPattern: /(^|\.)(?:test|tests|junit|testng)\./,
    reason: 'src/main code may not depend on src/test code.',
    suggestedFix: 'Extract shared fixture into src/main or a dedicated test-fixtures module.',
  },
];

const CSHARP_RULES: readonly IPolyglotBoundaryRule[] = [
  {
    id: 'csharp.domain.no-aspnet',
    title: 'Domain must not depend on ASP.NET',
    language: LanguageId.CSharp,
    severity: 'error',
    fromPattern: /(^|\/)Domain\//,
    forbiddenTargetPattern: /^Microsoft\.AspNetCore\./,
    reason: 'Clean architecture: outer layers depend inward; Domain stays framework-agnostic.',
    suggestedFix: 'Keep ASP.NET types in Web/Application; expose interfaces in Domain.',
  },
  {
    id: 'csharp.web.no-infrastructure-direct',
    title: 'Web project depends on Application, not Infrastructure',
    language: LanguageId.CSharp,
    severity: 'warning',
    fromPattern: /(^|\/)Web\//,
    forbiddenTargetPattern: /^.*\.Infrastructure\./,
    reason: 'Application orchestrates Infrastructure; Web should not bind to it directly.',
    suggestedFix: 'Call an Application service; inject Infrastructure via DI.',
  },
  {
    id: 'csharp.main.no-test-import',
    title: 'Production code must not import test projects',
    language: LanguageId.CSharp,
    severity: 'error',
    fromPattern: /\.cs$/,
    toPattern: /\.Tests\.csproj$/,
    forbiddenTargetPattern: /\.Tests(\.|$)/,
    reason: 'Production projects must not depend on test projects.',
    suggestedFix: 'Move shared helpers into a non-test project.',
  },
];

const PYTHON_RULES: readonly IPolyglotBoundaryRule[] = [
  {
    id: 'python.domain.no-web-framework',
    title: 'Domain must not import web frameworks',
    language: LanguageId.Python,
    severity: 'error',
    fromPattern: /(^|\/)domain(\/|\.)/i,
    forbiddenTargetPattern: /^(fastapi|django|flask|starlette)\b/,
    reason: 'Domain stays framework-agnostic.',
    suggestedFix: 'Wire web framework usage in the api/app layer; keep domain pure.',
  },
  {
    id: 'python.app.no-tests-import',
    title: 'Application code must not import the tests tree',
    language: LanguageId.Python,
    severity: 'error',
    fromPattern: /^(?:src|app)\//,
    forbiddenTargetPattern: /^(tests?|test_[a-z0-9_]+)(\.|$)/,
    reason: 'Production code must not depend on tests.',
    suggestedFix: 'Move shared fixtures to src/<package>/_fixtures.py or conftest.py.',
  },
  {
    id: 'python.no-cross-layer-parent-relative',
    title: 'Avoid relative imports across layers',
    language: LanguageId.Python,
    severity: 'warning',
    fromPattern: /\.py$/,
    forbiddenTargetPattern: /^\.\.\.+\w+/,
    reason: 'Deep parent-relative imports (`from ...x`) cross too many layers.',
    suggestedFix: 'Use an absolute import via the package root.',
  },
];

const GO_RULES: readonly IPolyglotBoundaryRule[] = [
  {
    id: 'go.pkg.no-cmd-import',
    title: 'pkg/ must not import cmd/',
    language: LanguageId.Go,
    severity: 'error',
    fromPattern: /^pkg\//,
    forbiddenTargetPattern: /\/cmd\//,
    reason: 'cmd/ is the entry point; library code must not depend on it.',
    suggestedFix: 'Move shared helpers out of cmd/ into pkg/ or internal/.',
  },
  {
    id: 'go.internal.visibility',
    title: 'internal/ must not be imported from outside its parent',
    language: LanguageId.Go,
    severity: 'error',
    fromPattern: /\.go$/,
    forbiddenTargetPattern: /\/internal\//,
    reason: 'Go enforces internal at compile time; surface it earlier in review.',
    suggestedFix: 'Promote the type to a non-internal package or duplicate the small helper.',
  },
  {
    id: 'go.no-import-cycle-hint',
    title: 'Watch for cyclic imports between sibling packages',
    language: LanguageId.Go,
    severity: 'warning',
    fromPattern: /\.go$/,
    forbiddenTargetPattern: /^cycle:.*$/,
    reason: 'Cyclic imports break compilation; surfaced from the dep-graph cycle list.',
    suggestedFix: 'Extract the cyclic surface into a third package both sides depend on.',
  },
];

const RUST_RULES: readonly IPolyglotBoundaryRule[] = [
  {
    id: 'rust.lib.no-tests-import',
    title: 'Library crate must not depend on tests/',
    language: LanguageId.Rust,
    severity: 'error',
    fromPattern: /^src\//,
    forbiddenTargetPattern: /^tests::/,
    reason: 'Production crate code must not depend on the tests/ tree.',
    suggestedFix: 'Move shared fixtures into src/test_helpers (gated by #[cfg(test)]).',
  },
  {
    id: 'rust.no-test-only-module-import',
    title: 'Do not import `#[cfg(test)]`-gated modules from non-test code',
    language: LanguageId.Rust,
    severity: 'warning',
    fromPattern: /\.rs$/,
    forbiddenTargetPattern: /^crate::test(_| ::)/,
    reason: 'cfg(test) modules disappear in release builds; relying on them breaks the build.',
    suggestedFix: 'Promote the symbol or wrap with #[cfg(test)] guard at the import site.',
  },
  {
    id: 'rust.no-super-cross-crate-hint',
    title: 'Avoid `super::super::super::` chains',
    language: LanguageId.Rust,
    severity: 'warning',
    fromPattern: /\.rs$/,
    forbiddenTargetPattern: /^(?:super::){3,}/,
    reason: 'Deep super chains indicate accidental crate boundary crossing.',
    suggestedFix: 'Reorganise the module tree or use `crate::` absolute paths.',
  },
];

const TYPESCRIPT_RULES: readonly IPolyglotBoundaryRule[] = [
  // TS rules deliberately live in the existing TS engine — kept empty
  // here so `--language all` doesn't return surprising TS results.
];

const ALL_RULES_BY_LANG: Readonly<Record<LanguageId, readonly IPolyglotBoundaryRule[]>> = {
  [LanguageId.TypeScript]: TYPESCRIPT_RULES,
  [LanguageId.JavaScript]: TYPESCRIPT_RULES,
  [LanguageId.Java]: JAVA_RULES,
  [LanguageId.CSharp]: CSHARP_RULES,
  [LanguageId.Python]: PYTHON_RULES,
  [LanguageId.Go]: GO_RULES,
  [LanguageId.Rust]: RUST_RULES,
  [LanguageId.Mixed]: [],
  [LanguageId.Unknown]: [],
};

export function listPolyglotBoundaryRules(language?: LanguageId): readonly IPolyglotBoundaryRule[] {
  if (language) return ALL_RULES_BY_LANG[language] ?? [];
  return [
    ...JAVA_RULES,
    ...CSHARP_RULES,
    ...PYTHON_RULES,
    ...GO_RULES,
    ...RUST_RULES,
  ];
}

function applyRule(rule: IPolyglotBoundaryRule, edge: IPolyglotImportEdge): IPolyglotBoundaryViolation | null {
  if (edge.language !== rule.language) return null;
  if (!rule.fromPattern.test(edge.from)) return null;
  if (rule.toPattern && edge.to && !rule.toPattern.test(edge.to)) return null;
  if (!rule.forbiddenTargetPattern.test(edge.to)) return null;
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  if (rule.severity === 'error') confidence = 'high';
  return {
    ruleId: rule.id,
    language: rule.language,
    severity: rule.severity,
    fromFile: edge.from,
    importSpecifier: edge.to,
    reason: rule.reason,
    suggestedFix: rule.suggestedFix,
    confidence,
  };
}

export function buildPolyglotBoundaryReport(
  options: IBuildPolyglotBoundaryReportOptions,
): IPolyglotBoundaryReport {
  const limit = options.limit ?? 200;
  const profile = options.cached ?? detectLanguageProfiles(options.projectRoot);
  const detected = new Set<LanguageId>(profile.profiles.map((p) => p.language));
  const wantedLanguages: readonly LanguageId[] = options.languages && options.languages.length > 0
    ? options.languages
    : [LanguageId.Java, LanguageId.CSharp, LanguageId.Python, LanguageId.Go, LanguageId.Rust];

  const evaluatedLanguages = wantedLanguages.filter((l) => detected.has(l));

  const rules: IPolyglotBoundaryRule[] = [];
  for (const lang of evaluatedLanguages) rules.push(...(ALL_RULES_BY_LANG[lang] ?? []));

  // Reuse caller's dep graph or compute one. When evaluatedLanguages is empty
  // we still produce an empty report rather than failing.
  let graph: IPolyglotDependencyGraph;
  if (options.graph) {
    graph = options.graph;
  } else if (evaluatedLanguages.length === 0) {
    graph = {
      schema: 'sharkcraft.polyglot-dependency-graph/v1' as const,
      generatedAt: new Date().toISOString(),
      projectRoot: options.projectRoot,
      perLanguage: [],
      notes: ['No applicable polyglot languages detected.'],
    };
  } else {
    graph = scanPolyglotDependencies(options.projectRoot, { languages: evaluatedLanguages });
  }

  const edges: IPolyglotImportEdge[] = [];
  for (const langDeps of graph.perLanguage) {
    if (!evaluatedLanguages.includes(langDeps.language)) continue;
    edges.push(...langDeps.imports);
  }

  const violations: IPolyglotBoundaryViolation[] = [];
  for (const edge of edges) {
    for (const rule of rules) {
      const v = applyRule(rule, edge);
      if (v) {
        violations.push(v);
        if (violations.length >= limit) break;
      }
    }
    if (violations.length >= limit) break;
  }

  const errors = violations.filter((v) => v.severity === 'error').length;
  const warnings = violations.filter((v) => v.severity === 'warning').length;

  const limitations: string[] = [
    'Polyglot dep scan is regex-based — false positives/negatives are possible.',
    'Rules are conservative built-ins; tune via project-local boundary rules when needed.',
  ];
  if (violations.length >= limit) {
    limitations.push(`Result capped at ${limit} violations; rerun with --limit to widen.`);
  }
  if (evaluatedLanguages.length === 0) {
    limitations.push('No applicable polyglot languages detected in the workspace.');
  }

  const suggestedFixes = Array.from(new Set(violations.map((v) => v.suggestedFix))).slice(0, 10);

  return {
    schema: POLYGLOT_BOUNDARY_REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: options.projectRoot,
    languages: evaluatedLanguages,
    rules,
    edges,
    violations,
    counts: { rules: rules.length, edges: edges.length, violations: violations.length, errors, warnings },
    limitations,
    suggestedFixes,
  };
}

export function renderPolyglotBoundaryReportText(r: IPolyglotBoundaryReport): string {
  let out = `=== Polyglot boundary report ===\n`;
  out += `  project root  ${r.projectRoot}\n`;
  out += `  languages     ${r.languages.join(', ') || '(none)'}\n`;
  out += `  rules         ${r.counts.rules}\n`;
  out += `  edges         ${r.counts.edges}\n`;
  out += `  violations    ${r.counts.violations}  (errors=${r.counts.errors}  warnings=${r.counts.warnings})\n`;
  if (r.violations.length > 0) {
    out += `\nViolations:\n`;
    for (const v of r.violations.slice(0, 60)) {
      out += `  [${v.severity}] ${v.ruleId}\n`;
      out += `    from   ${v.fromFile}\n`;
      out += `    import ${v.importSpecifier}\n`;
      out += `    fix    ${v.suggestedFix}\n`;
    }
    if (r.violations.length > 60) out += `  ... ${r.violations.length - 60} more\n`;
  }
  if (r.limitations.length > 0) {
    out += `\nLimitations:\n`;
    for (const l of r.limitations) out += `  - ${l}\n`;
  }
  return out;
}

export function renderPolyglotBoundaryReportMarkdown(r: IPolyglotBoundaryReport): string {
  const lines: string[] = [];
  lines.push('# Polyglot boundary report');
  lines.push('');
  lines.push(`- Languages: ${r.languages.map((l) => '`' + l + '`').join(', ') || '_(none)_'}`);
  lines.push(`- Rules: **${r.counts.rules}**`);
  lines.push(`- Edges: **${r.counts.edges}**`);
  lines.push(`- Violations: **${r.counts.violations}** (errors=${r.counts.errors}, warnings=${r.counts.warnings})`);
  lines.push('');
  if (r.violations.length > 0) {
    lines.push('## Violations');
    lines.push('');
    lines.push('| Severity | Rule | From | Import | Fix |');
    lines.push('|---|---|---|---|---|');
    for (const v of r.violations) {
      lines.push(`| ${v.severity} | \`${v.ruleId}\` | \`${v.fromFile}\` | \`${v.importSpecifier}\` | ${v.suggestedFix} |`);
    }
    lines.push('');
  }
  if (r.suggestedFixes.length > 0) {
    lines.push('## Suggested fixes');
    lines.push('');
    for (const f of r.suggestedFixes) lines.push(`- ${f}`);
    lines.push('');
  }
  if (r.limitations.length > 0) {
    lines.push('## Limitations');
    lines.push('');
    for (const l of r.limitations) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}

export function renderPolyglotBoundaryReportJson(r: IPolyglotBoundaryReport): string {
  // Strip RegExp objects from rules for safe JSON serialisation.
  const safe = {
    ...r,
    rules: r.rules.map((rule) => ({
      id: rule.id,
      title: rule.title,
      language: rule.language,
      severity: rule.severity,
      reason: rule.reason,
      suggestedFix: rule.suggestedFix,
    })),
  };
  return JSON.stringify(safe, null, 2);
}
