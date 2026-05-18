import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';

export interface IPackageJson {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  type?: 'module' | 'commonjs';
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
  engines?: Record<string, string>;
  bin?: string | Record<string, string>;
  [key: string]: unknown;
}

export function readPackageJson(projectRoot: string): Result<IPackageJson | null, AppError> {
  const pkgPath = nodePath.join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return ok(null);
  try {
    const raw = readFileSync(pkgPath, 'utf8');
    return ok(JSON.parse(raw) as IPackageJson);
  } catch (e) {
    return err(
      new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to parse package.json: ${pkgPath}`, {
        details: { pkgPath },
        cause: e,
      }),
    );
  }
}
