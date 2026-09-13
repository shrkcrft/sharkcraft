import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AppErrorImpl,
  ERROR_CODES,
  err,
  importModuleViaLoader,
  ok,
  resolvePlaneExtractors,
  unitProblemsOf,
  validateResolvedPlaneSources,
  type AppError,
  type Result,
} from '@shrkcrft/core';
import type { ISharkCraftConfig } from './sharkcraft-config.ts';
import { normalizePlaneConfig } from './normalize-plane-config.ts';
import { withDefaults } from './default-config.ts';
import { detectProjectRoot, findSharkcraftDir } from './project-config-resolver.ts';
import { SharkCraftConfigSchema } from './config-schema.ts';

export interface LoadedConfig {
  config: ISharkCraftConfig;
  projectRoot: string;
  sharkcraftDir: string;
  configFile: string | null;
}

const CONFIG_FILE_CANDIDATES = ['sharkcraft.config.ts', 'sharkcraft.config.js', 'sharkcraft.config.mjs'];


/**
 * Resolve every `$use` reference in the loaded config, then re-run the
 * structural source check on the MERGED shape.
 *
 * The schema deliberately cannot validate a `$use` source on its own — half its
 * fields arrive from the named extractor — so the "exactly one extraction mode,
 * per-kind required fields" contract is enforced here instead, on the source
 * the engines will actually run. Skipping this step is how a rule would load
 * fine and then quietly extract nothing.
 */
function resolveExtractorRefs(
  config: ISharkCraftConfig,
): { ok: true; config: ISharkCraftConfig } | { ok: false; message: string } {
  const extractors = config.extractors;
  const resolved = resolvePlaneExtractors(config, extractors);
  if (resolved.errors.length > 0) {
    return {
      ok: false,
      message: resolved.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    };
  }

  const merged: ISharkCraftConfig = { ...config, ...resolved };
  // THE post-resolution check (core) — the pack-plane merge seam and `gates
  // try` run the same one, so a `$use` source is judged identically everywhere.
  const problems = validateResolvedPlaneSources(merged).map((p) => `${p.path} ${p.message}`);
  if (problems.length > 0) return { ok: false, message: problems.join('; ') };
  return { ok: true, config: merged };
}

export async function loadProjectConfig(startDir: string): Promise<Result<LoadedConfig, AppError>> {
  const projectInfo = detectProjectRoot(startDir);
  const projectRoot = projectInfo.root;
  const folder = findSharkcraftDir(projectRoot);

  if (!folder) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.SHARKCRAFT_FOLDER_NOT_FOUND,
        `No sharkcraft/ folder found in ${projectRoot}`,
        { suggestion: 'Run `shrk init` to create one.', details: { projectRoot } },
      ),
    );
  }

  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const fullPath = nodePath.join(folder, candidate);
    if (!existsSync(fullPath)) continue;
    try {
      const mod = await importModuleViaLoader<{ default?: ISharkCraftConfig }>(fullPath);
      const userConfig = (mod.default ?? (mod as unknown as ISharkCraftConfig)) || {};

      const parsed = SharkCraftConfigSchema.safeParse(userConfig);
      if (!parsed.success) {
        const summary = parsed.error.issues
          .map((iss) => `${iss.path.join('.') || '<root>'}: ${iss.message}`)
          .join('; ');
        return err(
          new AppErrorImpl(
            ERROR_CODES.CONFIG_INVALID,
            `Invalid sharkcraft.config.ts: ${summary}`,
            {
              details: { fullPath, issues: parsed.error.issues },
              suggestion: 'Check the offending fields against ISharkCraftConfig.',
            },
          ),
        );
      }

      // Normalise every markable list (round 13) into the plain string list
      // the engines read plus its `expectEmptyUnits` ledger — BEFORE `$use`
      // resolution, so a consumer inherits an extractor's markers with its
      // `files` (and a local `files` override replaces them). The schema has
      // already refused every malformed marker; this cannot fail on a config
      // that parsed, and says so loudly if it ever does.
      const normalized = normalizePlaneConfig(parsed.data as ISharkCraftConfig);
      if (!normalized.ok) {
        return err(
          new AppErrorImpl(ERROR_CODES.CONFIG_INVALID, `Invalid sharkcraft.config.ts: ${normalized.error.message}`, {
            details: { fullPath, problems: unitProblemsOf(normalized.error) },
            suggestion: 'Write each list entry as a plain string, or as { pattern, expectEmpty: true, reason? }.',
          }),
        );
      }

      // Fold every `{ $use: "<id>" }` reference into a real source BEFORE any
      // engine sees the config. An unresolved reference is a typo in the
      // config, and a typo'd selector matches nothing — which every plane would
      // then report as a confident pass. So it fails the LOAD, loudly, with the
      // dotted path to the offending source.
      const resolved = resolveExtractorRefs(normalized.value);
      if (!resolved.ok) {
        return err(
          new AppErrorImpl(ERROR_CODES.CONFIG_INVALID, `Invalid sharkcraft.config.ts: ${resolved.message}`, {
            details: { fullPath },
            suggestion:
              'Declare the extractor in the top-level `extractors` map, or fix the `$use` id.',
          }),
        );
      }

      return ok({
        config: withDefaults(resolved.config),
        projectRoot,
        sharkcraftDir: folder,
        configFile: fullPath,
      });
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.CONFIG_INVALID,
          `Failed to load config: ${fullPath}`,
          { details: { fullPath }, cause: e },
        ),
      );
    }
  }

  // Fallback: no config file, use defaults
  return ok({
    config: withDefaults(null),
    projectRoot,
    sharkcraftDir: folder,
    configFile: null,
  });
}
