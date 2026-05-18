import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { ISharkCraftConfig } from './sharkcraft-config.ts';
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
      const mod = (await import(pathToFileURL(fullPath).href)) as { default?: ISharkCraftConfig };
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

      return ok({
        config: withDefaults(parsed.data as ISharkCraftConfig),
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
