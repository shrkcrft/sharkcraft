import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildOnboardingPlan,
  buildPolyglotBoundaryReport,
  inspectSharkcraft,
  LanguageId,
  renderPolyglotBoundaryReportJson,
  renderPolyglotBoundaryReportMarkdown,
  renderPolyglotBoundaryReportText,
  suggestBoundaryFixes,
  type suggestLanguageBoundaries,
} from '@shrkcrft/inspector';
import {
  evaluateBoundaries,
  loadTsconfigPaths,
  scanImports,
} from '@shrkcrft/boundaries';
import { flagBool, flagString, type ICommandHandler, type ParsedArgs, resolveCwd } from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

export const boundariesListCommand: ICommandHandler = {
  name: 'list',
  description: 'List all registered boundary rules (local + pack-contributed).',
  usage: 'shrk [--cwd <dir>] boundaries list [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const rules = inspection.boundaryRegistry.list();
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(rules) + '\n');
      return 0;
    }
    process.stdout.write(header(`Boundary rules (${rules.length})`));
    if (rules.length === 0) {
      process.stdout.write('  (none registered)\n');
      return 0;
    }
    for (const r of rules) {
      process.stdout.write(
        `  ${(r.severity ?? 'warning').toUpperCase().padEnd(8)} ${r.id.padEnd(36)} ${r.title}\n`,
      );
    }
    return 0;
  },
};

export const boundariesGetCommand: ICommandHandler = {
  name: 'get',
  description: 'Show one boundary rule (by id) in full.',
  usage: 'shrk [--cwd <dir>] boundaries get <ruleId> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk boundaries get <ruleId>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const rule = inspection.boundaryRegistry.get(id);
    if (!rule) {
      process.stderr.write(`No boundary rule with id "${id}".\n`);
      return 1;
    }
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(rule) + '\n');
      return 0;
    }
    process.stdout.write(header(`Boundary rule: ${rule.id}`));
    process.stdout.write(kv('title', rule.title) + '\n');
    process.stdout.write(kv('severity', rule.severity ?? 'warning') + '\n');
    if (rule.from && rule.from.length > 0) {
      process.stdout.write(kv('from', rule.from.join(', ')) + '\n');
    }
    if (rule.forbiddenImports && rule.forbiddenImports.length > 0) {
      process.stdout.write(kv('forbidden', rule.forbiddenImports.join(', ')) + '\n');
    }
    if (rule.allowedImports && rule.allowedImports.length > 0) {
      process.stdout.write(kv('allowed', rule.allowedImports.join(', ')) + '\n');
    }
    if (rule.suggestedFix) {
      process.stdout.write(kv('suggestedFix', rule.suggestedFix) + '\n');
    }
    return 0;
  },
};

export const boundariesExplainCommand: ICommandHandler = {
  name: 'explain',
  description:
    'Explain a boundary rule: where it came from (local vs pack), what it forbids, what to do about violations.',
  usage: 'shrk [--cwd <dir>] boundaries explain <ruleId> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk boundaries explain <ruleId>\n');
      return 2;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const rule = inspection.boundaryRegistry.get(id);
    if (!rule) {
      process.stderr.write(`No boundary rule with id "${id}".\n`);
      return 1;
    }
    const source = inspection.boundarySources.get(id);
    const explanation = {
      id: rule.id,
      title: rule.title,
      severity: rule.severity ?? 'warning',
      origin: source ? (source.type === 'pack' ? `pack: ${source.packageName}` : 'local') : 'unknown',
      from: rule.from ?? [],
      forbiddenImports: rule.forbiddenImports ?? [],
      allowedImports: rule.allowedImports ?? [],
      suggestedFix: rule.suggestedFix,
      howToFix:
        'Adjust the offending import to either (a) drop the disallowed dependency, (b) use a public interface from the allowed list, or (c) move the importer into a layer where this dependency is permitted.',
    };
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(explanation) + '\n');
      return 0;
    }
    process.stdout.write(header(`Boundary explain: ${rule.id}`));
    process.stdout.write(kv('title', rule.title) + '\n');
    process.stdout.write(kv('severity', rule.severity ?? 'warning') + '\n');
    process.stdout.write(kv('origin', explanation.origin) + '\n');
    if (explanation.from.length > 0) {
      process.stdout.write(kv('applies to', explanation.from.join(', ')) + '\n');
    }
    if (explanation.forbiddenImports.length > 0) {
      process.stdout.write(kv('forbidden', explanation.forbiddenImports.join(', ')) + '\n');
    }
    if (explanation.allowedImports.length > 0) {
      process.stdout.write(kv('allowed', explanation.allowedImports.join(', ')) + '\n');
    }
    if (rule.suggestedFix) process.stdout.write(`\nSuggested fix: ${rule.suggestedFix}\n`);
    process.stdout.write(`\nHow to fix: ${explanation.howToFix}\n`);
    return 0;
  },
};

export const boundariesInferCommand: ICommandHandler = {
  name: 'infer',
  description:
    'Infer candidate boundary rules from the current repo (monorepo structure, package boundaries, naming heuristics). Dry-run by default; --write-drafts writes to sharkcraft/boundary-drafts/boundaries.draft.ts. --language all|java|csharp|python|go|rust adds polyglot suggestions.',
  usage:
    'shrk [--cwd <dir>] boundaries infer [--write-drafts] [--language all|java|csharp|python|go|rust] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const plan = buildOnboardingPlan(inspection, {});
    const inferred = plan.inferredBoundaryRules;
    const langFlag = flagString(args, 'language');
    let languageSuggestions: ReturnType<typeof suggestLanguageBoundaries> | null = null;
    if (langFlag) {
      const { suggestLanguageBoundaries } = await import('@shrkcrft/inspector');
      const lang = langFlag.toLowerCase();
      languageSuggestions = suggestLanguageBoundaries(
        cwd,
        lang === 'all' ? {} : ({ language: lang } as Parameters<typeof suggestLanguageBoundaries>[1]),
      );
    }
    const wantJson = flagBool(args, 'json');
    const writeDrafts = flagBool(args, 'write-drafts');
    if (writeDrafts) {
      const outDir = nodePath.join(cwd, 'sharkcraft', 'boundary-drafts');
      mkdirSync(outDir, { recursive: true });
      const outFile = nodePath.join(outDir, 'boundaries.draft.ts');
      if (!outFile.startsWith(outDir + nodePath.sep)) {
        process.stderr.write('Refusing to write outside boundary-drafts dir.\n');
        return 1;
      }
      const body = renderInferredBoundariesDraft(inferred);
      writeFileSync(outFile, body, 'utf8');
      if (wantJson) {
        process.stdout.write(
          asJson({ mode: 'write-drafts', outFile, bytes: body.length, count: inferred.length }) +
            '\n',
        );
        return 0;
      }
      process.stdout.write(header('Boundary inference (write-drafts)'));
      process.stdout.write(kv('outFile', outFile) + '\n');
      process.stdout.write(kv('count', String(inferred.length)) + '\n');
      return 0;
    }
    if (wantJson) {
      process.stdout.write(asJson({ inferred, ...(languageSuggestions ? { languageSuggestions } : {}) }) + '\n');
      return 0;
    }
    process.stdout.write(header(`Inferred boundary rules (${inferred.length})`));
    if (inferred.length === 0) {
      process.stdout.write('  (no candidates inferred)\n');
    }
    for (const r of inferred) {
      process.stdout.write(
        `  ${r.severity.toUpperCase().padEnd(8)} ${r.id.padEnd(36)} ${r.title}\n`,
      );
      process.stdout.write(`           reason: ${r.reason}\n`);
    }
    if (languageSuggestions && languageSuggestions.suggestions.length > 0) {
      process.stdout.write(`\nPolyglot suggestions (${languageSuggestions.suggestions.length}):\n`);
      for (const s of languageSuggestions.suggestions) {
        process.stdout.write(
          `  ${s.severity.toUpperCase().padEnd(8)} [${s.language}] ${s.id.padEnd(48)} ${s.title}\n`,
        );
        process.stdout.write(`           reason: ${s.reason}\n`);
      }
    }
    process.stdout.write(
      '\nDry-run only. Re-run with `--write-drafts` to write sharkcraft/boundary-drafts/boundaries.draft.ts.\n',
    );
    return 0;
  },
};

function renderInferredBoundariesDraft(
  rules: readonly {
    id: string;
    title: string;
    severity: 'error' | 'warning';
    from: readonly string[];
    forbiddenImports?: readonly string[];
    allowedImports?: readonly string[];
    suggestedFix: string;
    reason: string;
  }[],
): string {
  const lines: string[] = [];
  lines.push('// Boundary rules inferred by `shrk boundaries infer --write-drafts`.');
  lines.push('// Review and copy keepers into sharkcraft/boundaries.ts.');
  lines.push('export default [');
  for (const r of rules) {
    lines.push(`  {`);
    lines.push(`    id: '${r.id}',`);
    lines.push(`    title: ${JSON.stringify(r.title)},`);
    lines.push(`    severity: '${r.severity}',`);
    lines.push(`    from: ${JSON.stringify(r.from)},`);
    if (r.forbiddenImports && r.forbiddenImports.length > 0) {
      lines.push(`    forbiddenImports: ${JSON.stringify(r.forbiddenImports)},`);
    }
    if (r.allowedImports && r.allowedImports.length > 0) {
      lines.push(`    allowedImports: ${JSON.stringify(r.allowedImports)},`);
    }
    lines.push(`    suggestedFix: ${JSON.stringify(r.suggestedFix)},`);
    lines.push(`    // reason: ${r.reason}`);
    lines.push(`  },`);
  }
  lines.push('];');
  return lines.join('\n') + '\n';
}

/** Polyglot enforcement subcommand. */
export const boundariesEnforceCommand: ICommandHandler = {
  name: 'enforce',
  description: 'Polyglot boundary enforcement report. Read-only; CLI-only — never mutates source.',
  usage: 'shrk [--cwd <dir>] boundaries enforce [--language all|java|csharp|python|go|rust|typescript] [--changed-only|--since <ref>|--staged|--files a,b,c] [--format text|markdown|json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const langFlag = (flagString(args, 'language') ?? 'all').toLowerCase();
    const languages = langFlag === 'all' ? undefined : [langFlag as LanguageId];
    const report = buildPolyglotBoundaryReport({ projectRoot: cwd, ...(languages ? { languages } : {}) });
    // Changed-only filtering against the polyglot report.
    const changedOnly = flagBool(args, 'changed-only');
    const staged = flagBool(args, 'staged');
    const since = flagString(args, 'since');
    const filesRaw = flagString(args, 'files');
    const fileList = filesRaw
      ? filesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const wantChangedScope = changedOnly || staged || Boolean(since) || fileList.length > 0;
    const { filterViolationsToChangedScope } = await import('@shrkcrft/inspector');
    const filtered = wantChangedScope
      ? filterViolationsToChangedScope(report.violations, {
          projectRoot: cwd,
          ...(fileList.length > 0 ? { files: fileList } : {}),
          ...(staged ? { staged: true } : {}),
          ...(since ? { since } : {}),
          ...(changedOnly && !staged && !since && fileList.length === 0
            ? { includeWorktree: true }
            : {}),
        })
      : null;
    const finalViolations = filtered ? filtered.includedViolations : report.violations;
    const errors = finalViolations.filter((v) => v.severity === 'error').length;
    const warnings = finalViolations.filter((v) => v.severity === 'warning').length;
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    if (flagBool(args, 'json') || format === 'json') {
      const payload = {
        ...report,
        violations: finalViolations,
        counts: { ...report.counts, errors, warnings },
        ...(filtered
          ? {
              changedScope: {
                mode: filtered.mode,
                changedFiles: filtered.changedFiles,
                ignoredLegacyCount: filtered.ignoredLegacyCount,
                ignoredLegacyByRule: filtered.ignoredLegacyByRule,
              },
            }
          : {}),
      };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      return errors > 0 ? 1 : 0;
    }
    if (format === 'markdown' || format === 'md') {
      process.stdout.write(renderPolyglotBoundaryReportMarkdown({ ...report, violations: finalViolations, counts: { ...report.counts, errors, warnings } }) + '\n');
      return errors > 0 ? 1 : 0;
    }
    // Default text path: render via existing renderer and append changed-scope footer.
    process.stdout.write(renderPolyglotBoundaryReportText({ ...report, violations: finalViolations, counts: { ...report.counts, errors, warnings } }));
    if (filtered) {
      process.stdout.write(`\nMode: ${filtered.mode}\n`);
      process.stdout.write(`Changed files: ${filtered.changedFiles.length}\n`);
      process.stdout.write(`Legacy ignored: ${filtered.ignoredLegacyCount}\n`);
      if (finalViolations.length === 0) {
        process.stdout.write('No polyglot boundary violations introduced by changed files.\n');
      }
    }
    return errors > 0 ? 1 : 0;
  },
};

export const boundariesSuggestCommand: ICommandHandler = {
  name: 'suggest',
  description: 'Suggest fixes for boundary violations (by rule id, file, or all).',
  usage: 'shrk boundaries suggest [<ruleId or file>] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const inspection = await inspectSharkcraft({ cwd });
    const rules = inspection.boundaryRegistry.list();
    if (rules.length === 0) {
      process.stderr.write('No boundary rules configured.\n');
      return 0;
    }
    const scan = scanImports({ projectRoot: cwd });
    const tsconfigPaths = loadTsconfigPaths(cwd);
    const evalResult = evaluateBoundaries(scan, rules, {
      ...(tsconfigPaths.aliases.size > 0 ? { tsconfigPaths } : {}),
    });
    const filter = args.positional[0];
    const filtered = filter
      ? evalResult.violations.filter((v) => v.ruleId === filter || v.file.includes(filter))
      : evalResult.violations;
    const suggestions = suggestBoundaryFixes(
      inspection,
      filtered.map((v) => ({
        ruleId: v.ruleId,
        file: v.file,
        line: v.line,
        importSpecifier: v.importSpecifier,
        ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
      })),
    );
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(suggestions) + '\n');
      return 0;
    }
    process.stdout.write(header(`Boundary fix suggestions (${suggestions.length})`));
    for (const s of suggestions) {
      process.stdout.write(`  ${s.ruleId}  ${s.file}:${s.line}\n`);
      for (const sug of s.suggestions) process.stdout.write(`    ↳ ${sug}\n`);
    }
    return 0;
  },
};
