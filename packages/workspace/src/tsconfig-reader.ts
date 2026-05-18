import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';

export interface ITsConfig {
  target?: string;
  module?: string;
  strict?: boolean;
  paths?: Record<string, string[]>;
  baseUrl?: string;
  extends?: string;
  raw: Record<string, unknown>;
}

const TSCONFIG_NAMES = ['tsconfig.json', 'tsconfig.base.json'];

export function readTsConfig(projectRoot: string): Result<ITsConfig | null, AppError> {
  for (const name of TSCONFIG_NAMES) {
    const file = nodePath.join(projectRoot, name);
    if (existsSync(file)) {
      try {
        const text = readFileSync(file, 'utf8');
        // strip // comments and trailing commas to handle JSON-with-comments tsconfigs
        const cleaned = text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
          .replace(/,(\s*[}\]])/g, '$1');
        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        const compilerOptions = (parsed.compilerOptions as Record<string, unknown>) ?? {};
        return ok({
          target: compilerOptions.target as string | undefined,
          module: compilerOptions.module as string | undefined,
          strict: compilerOptions.strict as boolean | undefined,
          paths: compilerOptions.paths as Record<string, string[]> | undefined,
          baseUrl: compilerOptions.baseUrl as string | undefined,
          extends: parsed.extends as string | undefined,
          raw: parsed,
        });
      } catch (e) {
        return err(
          new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to parse ${name}: ${file}`, {
            details: { file },
            cause: e,
          }),
        );
      }
    }
  }
  return ok(null);
}
