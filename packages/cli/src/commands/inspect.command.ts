import { inspectSharkcraft, buildProjectOverview, renderOverviewText } from '@shrkcrft/inspector';
import {
  flagBool,
  flagNumber,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, bullet, header, kv } from '../output/format-output.ts';
import { buildDetectedBlock, renderDetectedBlockText } from '../init/detected-block.ts';

export const inspectCommand: ICommandHandler = {
  name: 'inspect',
  description:
    'Inspect the current repository (project, frameworks, package manager, sharkcraft setup). Prints a Detected block so a brand-new user can see what zero-config init would do. `--no-config` tolerates a missing sharkcraft/ folder without warnings. `--debug` emits per-loader timing/status; `--no-cache` bypasses the persistent loader cache; `--loader-timeout <ms>` bounds each TS-asset import.',
  usage: 'shrk [--cwd <dir>] inspect [--no-config] [--json] [--debug] [--no-cache] [--loader-timeout <ms>]',
  async run(args: ParsedArgs): Promise<number> {
    const cwd = resolveCwd(args);
    const noConfig = flagBool(args, 'no-config');
    const noCache = flagBool(args, 'no-cache');
    const debug = flagBool(args, 'debug');
    const loaderTimeout = flagNumber(args, 'loader-timeout');
    const inspectOpts: { cwd: string; useCache?: boolean; loaderTimeoutMs?: number } = {
      cwd,
      useCache: !noCache,
    };
    if (typeof loaderTimeout === 'number' && loaderTimeout > 0) {
      inspectOpts.loaderTimeoutMs = loaderTimeout;
    }
    const inspection = await inspectSharkcraft(inspectOpts);
    const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
    const detected = buildDetectedBlock(cwd, inspection.workspace);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          targetRoot: inspection.projectRoot,
          overview,
          workspace: {
            projectRoot: inspection.workspace.projectRoot,
            packageManager: inspection.workspace.packageManager,
            frameworks: inspection.workspace.frameworks,
            hasTypeScript: inspection.workspace.hasTypeScript,
            scripts: Object.keys(inspection.workspace.scripts),
          },
          detected,
          noConfig,
          sharkcraft: {
            hasFolder: inspection.hasSharkcraftFolder,
            configFile: inspection.configFile,
            sharkcraftDir: inspection.sharkcraftDir,
            knowledgeCount: inspection.knowledgeEntries.length,
            ruleCount: inspection.ruleService.list().length,
            pathCount: inspection.pathService.list().length,
            templateCount: inspection.templates.length,
          },
          loader: {
            inspectionElapsedMs: inspection.inspectionElapsedMs,
            cacheEnabled: inspection.cacheEnabled,
            cacheDir: inspection.cacheDir,
            diagnostics: inspection.loaderDiagnostics,
          },
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header('Target'));
    process.stdout.write(kv('root', inspection.projectRoot) + '\n');

    process.stdout.write(header('Project'));
    process.stdout.write(renderOverviewText(overview) + '\n');

    process.stdout.write(header('Package manager'));
    process.stdout.write(kv('manager', inspection.workspace.packageManager.manager) + '\n');
    if (inspection.workspace.packageManager.version) {
      process.stdout.write(kv('version', inspection.workspace.packageManager.version) + '\n');
    }
    if (inspection.workspace.packageManager.evidence.length) {
      process.stdout.write(
        kv('evidence', inspection.workspace.packageManager.evidence.join(', ')) + '\n',
      );
    }

    if (inspection.workspace.frameworks.length) {
      process.stdout.write(header('Frameworks'));
      for (const f of inspection.workspace.frameworks) {
        process.stdout.write(bullet(`${f.name}${f.version ? ` (${f.version})` : ''}`) + '\n');
      }
    }

    process.stdout.write(header('Detected'));
    process.stdout.write(renderDetectedBlockText(detected) + '\n');

    process.stdout.write(header('SharkCraft setup'));
    process.stdout.write(kv('folder', inspection.sharkcraftDir ?? '(missing)') + '\n');
    process.stdout.write(kv('config', inspection.configFile ?? '(none)') + '\n');
    process.stdout.write(kv('knowledge entries', inspection.knowledgeEntries.length) + '\n');
    process.stdout.write(kv('rules', inspection.ruleService.list().length) + '\n');
    process.stdout.write(kv('path conventions', inspection.pathService.list().length) + '\n');
    process.stdout.write(kv('templates', inspection.templates.length) + '\n');

    // Under --no-config, downgrade missing-sharkcraft warnings so the
    // small-repo experience is friendly. Filter out the canonical "no
    // sharkcraft/" warning the inspector emits when the folder is absent.
    const warningsToShow = noConfig
      ? inspection.warnings.filter((w) => !/sharkcraft.*not found|sharkcraft.*missing|no\s+sharkcraft/i.test(w))
      : inspection.warnings;
    if (warningsToShow.length) {
      process.stdout.write(header('Warnings'));
      for (const w of warningsToShow) process.stdout.write(bullet(w) + '\n');
    }

    // Surface failed/timed-out/slow loaders outside of --debug so the
    // user is not silently flying blind when a pack asset fails to load.
    const problematic = inspection.loaderDiagnostics.filter(
      (d) => d.status !== 'ok' || d.slow,
    );
    if (problematic.length > 0) {
      process.stdout.write(header('Loader diagnostics'));
      for (const d of problematic) {
        process.stdout.write(
          bullet(
            `${d.kind} ${d.status} ${d.elapsedMs}ms ${d.filePath}${
              d.errorMessage ? ' — ' + d.errorMessage : ''
            }${d.suggestedNextCommand ? ' (try: ' + d.suggestedNextCommand + ')' : ''}`,
          ) + '\n',
        );
      }
    }

    if (debug) {
      process.stdout.write(header('Loader timing (--debug)'));
      process.stdout.write(
        kv('inspection elapsed', `${inspection.inspectionElapsedMs}ms`) + '\n',
      );
      process.stdout.write(
        kv('cache', inspection.cacheEnabled ? `on (${inspection.cacheDir})` : 'off') + '\n',
      );
      process.stdout.write(kv('loader entries', inspection.loaderDiagnostics.length) + '\n');
      for (const d of inspection.loaderDiagnostics) {
        process.stdout.write(
          `  ${d.kind.padEnd(10)} ${d.status.padEnd(12)} ${String(d.elapsedMs).padStart(5)}ms count=${d.count}${
            d.deduped ? ' (deduped)' : ''
          }${d.largeFile ? ' (large)' : ''}  ${d.filePath}\n`,
        );
        if (d.errorMessage) process.stdout.write(`      error: ${d.errorMessage}\n`);
      }
    }

    if (!inspection.hasSharkcraftFolder) {
      process.stdout.write(
        '\nNo sharkcraft/ folder yet. Next: `shrk init --zero-config` to preview a preset based on detection above.\n',
      );
    } else {
      process.stdout.write(
        '\nNext: run `shrk doctor` to validate setup, then `shrk context --task "<task>"`.\n',
      );
    }
    return 0;
  },
};
