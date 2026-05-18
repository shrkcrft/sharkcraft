import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

/**
 * Minimal tsconfig paths resolver. We read tsconfig.json and tsconfig.base.json
 * from the project root, then build a map of import-specifier patterns to
 * project-relative target paths. The resolver supports:
 *
 *   - Exact aliases:        "@scope/x": ["packages/x/src/index.ts"]
 *   - Wildcard aliases:     "@scope/*": ["packages/*\/src/index.ts"]
 *
 * v1 does NOT resolve node_modules, .d.ts vs .js variants, or index lookups.
 * The result is a list of *candidate paths*; the boundary evaluator matches
 * those candidates against `from` patterns just like literal specifiers.
 */

export interface ITsconfigPathsMap {
  baseUrl: string;
  /** Each alias maps to one or more target patterns. */
  aliases: ReadonlyMap<string, readonly string[]>;
  /** Source files actually read (for cache invalidation / debug). */
  sources: readonly string[];
}

function readJsonRelaxed(p: string): unknown {
  // tsconfig allows // line comments, /* block comments */, and trailing
  // commas. The naive regex approach mangles real string values that happen
  // to contain "/*" or "//" (e.g. wildcard paths like "packages/*/src/index.ts"
  // or URL fragments). Walk char-by-char and track string state so we only
  // strip syntactic comments + trailing commas, never content inside strings.
  try {
    const raw = readFileSync(p, 'utf8');
    const out: string[] = [];
    let i = 0;
    let inString = false;
    let stringQuote = '';
    let escape = false;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (inString) {
        out.push(ch);
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === stringQuote) {
          inString = false;
        }
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringQuote = ch;
        out.push(ch);
        i += 1;
        continue;
      }
      // Line comment
      if (ch === '/' && raw[i + 1] === '/') {
        while (i < raw.length && raw[i] !== '\n') i += 1;
        continue;
      }
      // Block comment
      if (ch === '/' && raw[i + 1] === '*') {
        i += 2;
        while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      out.push(ch);
      i += 1;
    }
    // Remove trailing commas before } or ]. Safe outside strings now.
    const trimmed = out.join('').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Read tsconfig(.base).json from `projectRoot` and return a normalized map of
 * paths aliases. Both files are tried; entries from tsconfig.json win on
 * conflict.
 */
export function loadTsconfigPaths(projectRoot: string): ITsconfigPathsMap {
  const sources: string[] = [];
  const aliases = new Map<string, readonly string[]>();
  let baseUrl: string | undefined;

  const candidates = ['tsconfig.base.json', 'tsconfig.json'];
  for (const name of candidates) {
    const full = nodePath.join(projectRoot, name);
    if (!existsSync(full)) continue;
    const json = readJsonRelaxed(full) as {
      compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
    } | null;
    if (!json?.compilerOptions) continue;
    sources.push(full);
    if (json.compilerOptions.baseUrl && !baseUrl) baseUrl = json.compilerOptions.baseUrl;
    for (const [k, v] of Object.entries(json.compilerOptions.paths ?? {})) {
      if (!aliases.has(k)) aliases.set(k, v);
    }
  }
  return {
    baseUrl: baseUrl ?? '.',
    aliases,
    sources,
  };
}

/**
 * Given an import specifier, return the list of project-relative target paths
 * the tsconfig paths map would resolve it to.
 *
 * Returns an empty array when no alias matches. The original specifier is NOT
 * included; the caller is expected to keep using both.
 */
export function resolveAliasCandidates(
  specifier: string,
  map: ITsconfigPathsMap,
): string[] {
  // Exact alias first.
  const exact = map.aliases.get(specifier);
  if (exact) return [...exact.map((t) => normalize(map.baseUrl, t))];
  // Wildcard alias: pattern ends with `*`.
  for (const [pattern, targets] of map.aliases) {
    if (!pattern.endsWith('*')) continue;
    const prefix = pattern.slice(0, -1);
    if (!specifier.startsWith(prefix)) continue;
    const suffix = specifier.slice(prefix.length);
    return targets.map((t) => normalize(map.baseUrl, t.replace('*', suffix)));
  }
  return [];
}

function normalize(baseUrl: string, target: string): string {
  // Strip leading "./" and join with baseUrl if non-trivial.
  let t = target.replace(/^\.\//, '');
  if (baseUrl && baseUrl !== '.' && baseUrl !== './') {
    t = nodePath.posix.join(baseUrl.replace(/^\.\//, ''), t);
  }
  return t;
}
