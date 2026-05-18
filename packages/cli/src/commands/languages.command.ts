import { mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  buildLanguageCommandReport,
  buildLanguageRunPlan,
  buildPolyglotBoundaryReport,
  clearLanguageCache,
  computePolyglotTestImpact,
  defaultLanguageRunReportPath,
  detectLanguageProfiles,
  detectLanguageProfilesWithCache,
  getLanguageCacheStatus,
  LanguageId,
  renderLanguageCommandsMarkdown,
  renderLanguageCommandsText,
  renderLanguageProfilesMarkdown,
  renderLanguageProfilesText,
  renderLanguageRunPlanJson,
  renderLanguageRunPlanMarkdown,
  renderLanguageRunPlanText,
  renderPolyglotBoundaryReportJson,
  renderPolyglotBoundaryReportMarkdown,
  renderPolyglotBoundaryReportText,
  renderPolyglotDependenciesText,
  renderPolyglotTestImpactText,
  scanPolyglotDependencies,
  type LanguageRunCategory,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson } from '../output/format-output.ts';

function writeOutOrPrint(args: ParsedArgs, cwd: string, body: string): number {
  const out = flagString(args, 'output');
  if (out) {
    const abs = nodePath.isAbsolute(out) ? out : nodePath.resolve(cwd, out);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
    process.stdout.write(`Wrote ${abs}\n`);
    return 0;
  }
  process.stdout.write(body);
  return 0;
}

const SHARKCRAFT_VERSION = '0.1.0';

const languagesDetectCommand: ICommandHandler = {
  name: 'detect',
  description: 'Detect language profiles in the current project (TS/JS/Java/C#/Python/Go/Rust). Read-only. Pass --cache to use/refresh the language cache.',
  usage: 'shrk languages detect [--format text|markdown|json] [--cache] [--refresh-cache] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const useCache = flagBool(args, 'cache');
    const refreshCache = flagBool(args, 'refresh-cache');
    let report;
    let cacheHit = false;
    let staleReasons: readonly string[] = [];
    if (useCache || refreshCache) {
      const r = detectLanguageProfilesWithCache({ projectRoot: cwd, sharkcraftVersion: SHARKCRAFT_VERSION, useCache, refresh: refreshCache });
      report = r.report;
      cacheHit = r.cacheHit;
      staleReasons = r.staleReasons;
    } else {
      report = detectLanguageProfiles(cwd);
    }
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) {
      body = asJson({ ...report, _cacheHit: cacheHit, _staleReasons: staleReasons }) + '\n';
    } else if (format === 'markdown' || format === 'md') {
      body = renderLanguageProfilesMarkdown(report);
      if (cacheHit) body += `\n_(loaded from cache; stale: ${staleReasons.length > 0})_\n`;
    } else {
      body = renderLanguageProfilesText(report);
      if (cacheHit) body += `\n(loaded from cache; stale: ${staleReasons.length > 0})\n`;
    }
    return writeOutOrPrint(args, cwd, body);
  },
};

const languagesCacheCommand: ICommandHandler = {
  name: 'cache',
  description: 'Language profile cache: `shrk languages cache status` / `cache clear --write`. Default dry-run.',
  usage: 'shrk languages cache <status|clear> [--write] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const sub = args.positional[0] ?? 'status';
    if (sub === 'status') {
      const status = getLanguageCacheStatus(cwd, SHARKCRAFT_VERSION);
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(status) + '\n');
        return 0;
      }
      process.stdout.write(`=== Language cache ===\n`);
      process.stdout.write(`  file:        ${status.cacheFile}\n`);
      process.stdout.write(`  exists:      ${status.exists ? 'yes' : 'no'}\n`);
      if (status.exists) {
        process.stdout.write(`  cached at:   ${status.cachedAt ?? '(unknown)'}\n`);
        process.stdout.write(`  fresh:       ${status.fresh ? 'yes' : 'no'}\n`);
        if (status.staleReasons.length > 0) {
          process.stdout.write(`  stale because:\n`);
          for (const r of status.staleReasons) process.stdout.write(`    - ${r}\n`);
        }
      }
      return 0;
    }
    if (sub === 'clear') {
      const write = flagBool(args, 'write');
      const res = clearLanguageCache(cwd, { write });
      if (flagBool(args, 'json')) {
        process.stdout.write(asJson(res) + '\n');
        return 0;
      }
      if (!write) {
        process.stdout.write(`Would remove ${res.cacheFile}\n  (re-run with --write to actually delete)\n`);
      } else {
        process.stdout.write(res.cleared ? `Removed ${res.cacheFile}\n` : `Nothing to remove at ${res.cacheFile}\n`);
      }
      return 0;
    }
    process.stderr.write(`Unknown subcommand: ${sub}\n`);
    return 2;
  },
};

const languagesRunCommand: ICommandHandler = {
  name: 'run',
  description: 'Plan or execute a language command (test/build/lint/format/check/typecheck). Dry-run by default; --execute to run; --allow-install to permit install/restore.',
  usage: 'shrk languages run [--category test|build|lint|format|check|all] [--language <id>] [--command-id <lang.cat>] [--all-tests] [--execute] [--allow-install] [--report] [--format text|markdown|json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const category = (flagString(args, 'category') ?? 'test') as LanguageRunCategory;
    const language = flagString(args, 'language') as LanguageId | undefined;
    const commandId = flagString(args, 'command-id');
    const allTests = flagBool(args, 'all-tests');
    const execute = flagBool(args, 'execute');
    const allowInstall = flagBool(args, 'allow-install');
    const wantReport = flagBool(args, 'report');
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    // Optional policy explanation block.
    const explainPolicy = flagBool(args, 'explain-policy');
    const plan = buildLanguageRunPlan({
      projectRoot: cwd,
      category,
      ...(language ? { language } : {}),
      ...(commandId ? { commandId } : {}),
      allTests,
      execute,
      allowInstall,
    });
    if (explainPolicy) {
      const { getLanguageRunnerPolicy, explainCommandPolicy } = await import('@shrkcrft/inspector');
      const policy = getLanguageRunnerPolicy(cwd);
      const decisions = plan.steps.map((s) => ({
        command: s.command,
        decision: explainCommandPolicy(s.command, cwd),
      }));
      const body = JSON.stringify({ policy, decisions }, null, 2) + '\n';
      return writeOutOrPrint(args, cwd, body);
    }
    if (wantReport) {
      const reportPath = defaultLanguageRunReportPath(cwd, plan.generatedAt);
      mkdirSync(nodePath.dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, renderLanguageRunPlanJson(plan), 'utf8');
      process.stderr.write(`wrote ${reportPath}\n`);
    }
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = renderLanguageRunPlanJson(plan) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderLanguageRunPlanMarkdown(plan);
    else body = renderLanguageRunPlanText(plan);
    return writeOutOrPrint(args, cwd, body);
  },
};

const languagesBoundariesCommand: ICommandHandler = {
  name: 'boundaries',
  description: 'Polyglot boundary enforcement report. Read-only.',
  usage: 'shrk languages boundaries [--language java|csharp|python|go|rust|all] [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const langFlag = (flagString(args, 'language') ?? 'all').toLowerCase();
    const languages: LanguageId[] | undefined = langFlag === 'all'
      ? undefined
      : [langFlag as LanguageId];
    const report = buildPolyglotBoundaryReport({ projectRoot: cwd, ...(languages ? { languages } : {}) });
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = renderPolyglotBoundaryReportJson(report) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderPolyglotBoundaryReportMarkdown(report);
    else body = renderPolyglotBoundaryReportText(report);
    return writeOutOrPrint(args, cwd, body);
  },
};

const languagesCommandsCommand: ICommandHandler = {
  name: 'commands',
  description: 'Infer install / test / typecheck / lint / build commands per detected language. Read-only.',
  usage: 'shrk languages commands [--format text|markdown|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const report = buildLanguageCommandReport(cwd);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(report) + '\n';
    else if (format === 'markdown' || format === 'md') body = renderLanguageCommandsMarkdown(report);
    else body = renderLanguageCommandsText(report);
    return writeOutOrPrint(args, cwd, body);
  },
};

const languagesDepsCommand: ICommandHandler = {
  name: 'deps',
  description: 'Scan polyglot dependency graph (Java/C#/Python/Go/Rust imports). Read-only.',
  usage: 'shrk languages deps [--language java|csharp|python|go|rust|all] [--format text|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const langFlag = (flagString(args, 'language') ?? 'all').toLowerCase();
    const languages: LanguageId[] = langFlag === 'all'
      ? [LanguageId.Java, LanguageId.CSharp, LanguageId.Python, LanguageId.Go, LanguageId.Rust]
      : [langFlag as LanguageId];
    const graph = scanPolyglotDependencies(cwd, { languages });
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(graph) + '\n';
    else body = renderPolyglotDependenciesText(graph);
    return writeOutOrPrint(args, cwd, body);
  },
};

const languagesTestsCommand: ICommandHandler = {
  name: 'tests',
  description: 'Predict per-language test files impacted by a set of changed source files. Read-only.',
  usage: 'shrk languages tests --files a,b,c [--format text|json] [--output <file>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const filesFlag = flagString(args, 'files');
    if (!filesFlag) {
      process.stderr.write('--files <a,b,c> is required.\n');
      return 2;
    }
    const files = filesFlag.split(',').map((f) => f.trim()).filter(Boolean);
    const report = computePolyglotTestImpact(cwd, files);
    const format = (flagString(args, 'format') ?? 'text').toLowerCase();
    let body: string;
    if (format === 'json' || flagBool(args, 'json')) body = asJson(report) + '\n';
    else body = renderPolyglotTestImpactText(report);
    return writeOutOrPrint(args, cwd, body);
  },
};

export const languagesCommand: ICommandHandler = {
  name: 'languages',
  description:
    'Polyglot language support: detect language profiles, infer commands, scan dependencies, predict test impact, enforce boundaries, run safe commands, manage cache. Read-only by default.',
  usage: 'shrk languages <detect|commands|deps|tests|boundaries|run|cache> [...]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (!sub) {
      process.stderr.write('Usage: shrk languages <detect|commands|deps|tests|boundaries|run|cache>\n');
      return 2;
    }
    const next = { ...args, positional: args.positional.slice(1) };
    if (sub === 'detect') return (await languagesDetectCommand.run(next)) as number;
    if (sub === 'commands') return (await languagesCommandsCommand.run(next)) as number;
    if (sub === 'deps') return (await languagesDepsCommand.run(next)) as number;
    if (sub === 'tests') return (await languagesTestsCommand.run(next)) as number;
    if (sub === 'boundaries') return (await languagesBoundariesCommand.run(next)) as number;
    if (sub === 'run') return (await languagesRunCommand.run(next)) as number;
    if (sub === 'cache') return (await languagesCacheCommand.run(next)) as number;
    if (sub === 'runner') {
      const sub2 = next.positional[0];
      const next2 = { ...next, positional: next.positional.slice(1) };
      if (sub2 === 'config') return (await languagesRunnerConfigCommand.run(next2)) as number;
      process.stderr.write(`Usage: shrk languages runner config\n`);
      return 2;
    }
    process.stderr.write(`Unknown subcommand: ${sub}\n`);
    return 2;
  },
};

const languagesRunnerConfigCommand: ICommandHandler = {
  name: 'config',
  description: 'Show the language runner policy (allowlist + denylist + built-in deny patterns). Read-only.',
  usage: 'shrk languages runner config [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const { getLanguageRunnerPolicy } = await import('@shrkcrft/inspector');
    const policy = getLanguageRunnerPolicy(cwd);
    if (flagBool(args, 'json')) {
      process.stdout.write(asJson(policy) + '\n');
      return 0;
    }
    process.stdout.write('=== Language runner policy ===\n');
    process.stdout.write(`  source: ${policy.source}\n`);
    process.stdout.write(`  allow:  ${policy.allow.length}\n`);
    for (const a of policy.allow) {
      process.stdout.write(`    + ${a.command}${a.reason ? `  (${a.reason})` : ''}\n`);
    }
    process.stdout.write(`  deny:   ${policy.deny.length}\n`);
    for (const d of policy.deny) {
      process.stdout.write(`    - /${d.pattern}/${d.reason ? `  (${d.reason})` : ''}\n`);
    }
    process.stdout.write(`  built-in deny: ${policy.builtinDeny.length}\n`);
    for (const b of policy.builtinDeny) process.stdout.write(`    - /${b}/\n`);
    return 0;
  },
};
