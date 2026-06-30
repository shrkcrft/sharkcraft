import { existsSync, readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';

export interface ITsConfig {
  target?: string;
  module?: string;
  /**
   * Effective `compilerOptions.strict`, resolved through a relative
   * `extends` chain when not set directly. `undefined` only when strict
   * could NOT be resolved (extends a non-relative package / missing base);
   * inspect {@link strictResolvable} to disambiguate.
   */
  strict?: boolean;
  /**
   * Tri-state confidence for {@link strict}:
   *   - `true`  → strict was conclusively resolved (set directly, inherited
   *               from a resolvable relative base, or absent with no further
   *               extends → TS default `false`).
   *   - `false` → strict is unknown: the `extends` chain hit a non-relative
   *               package, a missing/unparseable base file, or exceeded the
   *               depth bound, and no explicit `strict` was found.
   */
  strictResolvable: boolean;
  paths?: Record<string, string[]>;
  baseUrl?: string;
  extends?: string;
  raw: Record<string, unknown>;
}

const TSCONFIG_NAMES = ['tsconfig.json', 'tsconfig.base.json'];

/** Bound on how far we follow a relative `extends` chain. */
const MAX_EXTENDS_DEPTH = 5;

interface IParsedTsConfig {
  compilerOptions: Record<string, unknown>;
  extends?: string;
  raw: Record<string, unknown>;
}

/** Strip // and /* *\/ comments + trailing commas so JSON.parse accepts tsconfigs. */
function parseTsConfigText(text: string): Record<string, unknown> {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(cleaned) as Record<string, unknown>;
}

function parseTsConfigFile(file: string): IParsedTsConfig | null {
  try {
    const text = readFileSync(file, 'utf8');
    const parsed = parseTsConfigText(text);
    const compilerOptions =
      (parsed.compilerOptions as Record<string, unknown> | undefined) ?? {};
    return {
      compilerOptions,
      extends: typeof parsed.extends === 'string' ? parsed.extends : undefined,
      raw: parsed,
    };
  } catch {
    return null;
  }
}

function isRelativeExtends(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

/**
 * Resolve a relative `extends` spec (with or without a `.json` suffix)
 * against the directory of the file that declared it. Returns the absolute
 * path of an existing file, or `null` when it cannot be located.
 */
function resolveRelativeExtends(fromFile: string, spec: string): string | null {
  const baseDir = nodePath.dirname(fromFile);
  const direct = nodePath.resolve(baseDir, spec);
  const candidates = spec.endsWith('.json') ? [direct] : [direct, `${direct}.json`];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore and try the next candidate
    }
  }
  return null;
}

/**
 * Walk a relative `extends` chain looking for an explicit
 * `compilerOptions.strict`. The chain is bounded ({@link MAX_EXTENDS_DEPTH})
 * and cycle-guarded.
 */
function resolveStrict(
  file: string,
  compilerOptions: Record<string, unknown>,
  extendsSpec: string | undefined,
  depth: number,
  seen: Set<string>,
): { strict: boolean; resolvable: boolean } {
  if (typeof compilerOptions.strict === 'boolean') {
    return { strict: compilerOptions.strict, resolvable: true };
  }
  // No explicit strict here — try to inherit it from a relative base.
  if (extendsSpec !== undefined) {
    if (depth >= MAX_EXTENDS_DEPTH) {
      // Depth bound hit with an unresolved chain — treat as unknown.
      return { strict: false, resolvable: false };
    }
    if (!isRelativeExtends(extendsSpec)) {
      // A bare/scoped package base (e.g. `@tsconfig/strictest`); we do not
      // perform node module resolution → strict is unknown.
      return { strict: false, resolvable: false };
    }
    const resolved = resolveRelativeExtends(file, extendsSpec);
    if (!resolved || seen.has(resolved)) {
      // Missing base file or a cycle → unknown.
      return { strict: false, resolvable: false };
    }
    seen.add(resolved);
    const parsed = parseTsConfigFile(resolved);
    if (!parsed) {
      // Existed but unparseable → unknown.
      return { strict: false, resolvable: false };
    }
    return resolveStrict(resolved, parsed.compilerOptions, parsed.extends, depth + 1, seen);
  }
  // No explicit strict and no further extends → TS default is `false`,
  // and we know the full picture, so this is conclusive.
  return { strict: false, resolvable: true };
}

export function readTsConfig(projectRoot: string): Result<ITsConfig | null, AppError> {
  for (const name of TSCONFIG_NAMES) {
    const file = nodePath.join(projectRoot, name);
    if (existsSync(file)) {
      try {
        const text = readFileSync(file, 'utf8');
        const parsed = parseTsConfigText(text);
        const compilerOptions = (parsed.compilerOptions as Record<string, unknown>) ?? {};
        const extendsSpec =
          typeof parsed.extends === 'string' ? parsed.extends : undefined;
        const resolution = resolveStrict(
          file,
          compilerOptions,
          extendsSpec,
          0,
          new Set([file]),
        );
        return ok({
          target: compilerOptions.target as string | undefined,
          module: compilerOptions.module as string | undefined,
          ...(resolution.resolvable ? { strict: resolution.strict } : {}),
          strictResolvable: resolution.resolvable,
          paths: compilerOptions.paths as Record<string, string[]> | undefined,
          baseUrl: compilerOptions.baseUrl as string | undefined,
          extends: extendsSpec,
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
