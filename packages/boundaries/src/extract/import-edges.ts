import type { IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { resolveAliasCandidates, type ITsconfigPathsMap } from '../scan/tsconfig-aliases.ts';
import { safeCompile } from '../util/safe-regex.ts';
import { parseImportStatements } from './parse-imports.ts';
import type { IExtractFileEntry, IExtractedSite } from './extract-tokens.ts';

/**
 * The `import-edges` extractor — the dependency graph as a rule input.
 *
 * Every other extractor reads file CONTENTS: a regex, an array literal, an enum
 * body, an export list. None of them can see which file imports what, so an
 * entire class of invariant — alias-resolved dependency direction — was
 * inexpressible as a rule, and repos hand-rolled scripts for it (adoption
 * ledgers, orphan scans, deprecation ratchets).
 *
 * This emits that missing fact as an id set, so every existing plane gets it for
 * free: a `baseline` over the set is an adoption ledger (a LOST edge is a silent
 * de-adoption); `direction: 'no-shrink'` over the importer set is a deprecation
 * ratchet; a `wiring` rule whose registered side is "symbols with ≥1 importer"
 * finds dead generated code a byte-drift gate cannot see.
 *
 * **On freshness.** It reads the files the caller already walked, resolving
 * specifiers on the spot — there is no persisted graph index behind it and
 * therefore no staleness question to get wrong. That is deliberate: a rule
 * answering from a stale graph would be a confident false green, the exact
 * failure this engine exists to prevent.
 *
 * **Honest scope.** It resolves what the text says plus tsconfig path aliases —
 * the same resolution `check boundaries` uses. It does not follow a re-export
 * chain to attribute a symbol to its original module: a barrel is reported as
 * the module the consumer actually names. That is a lexer's honest answer, and
 * `to.files` matches the resolved target when you need the real path.
 */

/** What an emitted id represents. */
export type ImportEdgeEmit = 'edge' | 'symbol' | 'from';

/** How an import specifier resolved against the project. */
interface IResolvedSpecifier {
  /** The literal specifier as written. */
  readonly specifier: string;
  /** Project-relative target path, for a relative or alias-mapped specifier. */
  readonly path?: string;
}

/** Normalize a relative specifier against the importing file's directory. */
function resolveRelative(fromFile: string, specifier: string): string {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const stack: string[] = dir.split('/').filter(Boolean);
  for (const part of specifier.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/**
 * Resolve a specifier the way the boundary engine does: relative paths against
 * the importing file, bare specifiers through the tsconfig alias map, and
 * anything left over kept as the literal package name.
 */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  aliases: ITsconfigPathsMap | undefined,
): IResolvedSpecifier {
  if (specifier.startsWith('.')) {
    return { specifier, path: resolveRelative(fromFile, specifier) };
  }
  if (aliases) {
    const candidates = resolveAliasCandidates(specifier, aliases);
    // The first candidate is the one the compiler would try first; keeping only
    // it makes the emitted id deterministic rather than order-dependent.
    if (candidates.length > 0) return { specifier, path: candidates[0]! };
  }
  return { specifier };
}

/** Whether a resolved specifier is one the rule's `to` selects. */
function matchesTarget(
  resolved: IResolvedSpecifier,
  to: NonNullable<IWiringSource['to']>,
  modulePattern: RegExp | undefined,
): boolean {
  const hasSelector =
    to.module !== undefined || to.modulePattern !== undefined || (to.files?.length ?? 0) > 0;
  // No target selector at all means "every import" — useful when the rule
  // narrows by symbol alone.
  if (!hasSelector) return true;

  if (to.module !== undefined) {
    // Exact package, or a subpath of it: `@x/generated` selects
    // `@x/generated` and `@x/generated/views` but never `@x/generated-legacy`.
    if (resolved.specifier === to.module || resolved.specifier.startsWith(`${to.module}/`)) {
      return true;
    }
  }
  if (modulePattern) {
    modulePattern.lastIndex = 0;
    if (modulePattern.test(resolved.specifier)) return true;
  }
  if (to.files && to.files.length > 0 && resolved.path !== undefined) {
    if (matchesAny(resolved.path, to.files)) return true;
    // Specifiers routinely omit the extension, so probe the usual endings
    // rather than forcing every config to spell `*.{ts,tsx,…}` itself.
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx']) {
      if (matchesAny(resolved.path + ext, to.files)) return true;
      if (matchesAny(`${resolved.path}/index${ext}`, to.files)) return true;
    }
  }
  return false;
}

/** Context a caller supplies so alias specifiers resolve. */
export interface IImportEdgeContext {
  readonly tsconfigPaths?: ITsconfigPathsMap;
}

/**
 * Extract the import edges a source selects.
 *
 * `files` is the CONSUMER glob (the `from` side): it reuses the field every
 * other extractor uses, so `--changed-only` footprinting, the shared walk, and
 * `$use` all work on it unchanged.
 */
export function extractImportEdges(
  source: IWiringSource,
  files: readonly IExtractFileEntry[],
  context: IImportEdgeContext = {},
): { sites: IExtractedSite[]; error?: string; hint?: string } {
  const to = source.to ?? {};
  const emit: ImportEdgeEmit = source.emit ?? 'edge';

  let modulePattern: RegExp | undefined;
  if (to.modulePattern !== undefined) {
    const compiled = safeCompile(to.modulePattern, to.modulePatternFlags);
    if (compiled.error || !compiled.re) return { sites: [], error: `to.modulePattern ${compiled.error}` };
    modulePattern = compiled.re;
  }
  let symbolPattern: RegExp | undefined;
  if (to.match !== undefined) {
    const compiled = safeCompile(to.match, to.matchFlags);
    if (compiled.error || !compiled.re) return { sites: [], error: `to.match ${compiled.error}` };
    symbolPattern = compiled.re;
  }

  const sites: IExtractedSite[] = [];
  for (const file of files) {
    for (const statement of parseImportStatements(file.content)) {
      const resolved = resolveSpecifier(file.path, statement.specifier, context.tsconfigPaths);
      if (!matchesTarget(resolved, to, modulePattern)) continue;

      const symbols = statement.bindings
        .map((b) => b.imported ?? b.local)
        .filter((name) => {
          if (!symbolPattern) return true;
          symbolPattern.lastIndex = 0;
          return symbolPattern.test(name);
        });

      // A symbol filter that matched nothing means this statement is not a hit,
      // even though its module was: the rule asked about specific symbols.
      if (symbolPattern && symbols.length === 0) continue;

      if (emit === 'from') {
        sites.push({ token: file.path, file: file.path, line: statement.line });
        continue;
      }
      if (symbols.length === 0) {
        // A side-effect or type-only import binds no name; the edge is still a
        // real dependency, so it is reported against the module it names.
        if (emit === 'symbol') continue;
        sites.push({
          token: `${file.path} → ${resolved.specifier}`,
          file: file.path,
          line: statement.line,
        });
        continue;
      }
      for (const symbol of symbols) {
        sites.push({
          token: emit === 'symbol' ? symbol : `${file.path} → ${symbol}`,
          file: file.path,
          line: statement.line,
        });
      }
    }
  }
  // The one place a user's intuition reliably trips: `to.files` matches an
  // import's DIRECTLY-resolved path, and a symbol re-exported through a barrel
  // resolves to the package entry, not the deep file. "Edges to files in
  // generated/**" then finds nothing, correctly but unhelpfully. Detecting the
  // exact shape of that dead end and naming the fix costs one conditional.
  //
  // Narrow on purpose. A rule that ALREADY targets by module has been told to
  // use the thing it is using, which is worse than saying nothing — so the
  // hint fires only when `to.files` is the sole target selector.
  const targetsByFilesOnly =
    (to.files?.length ?? 0) > 0 && to.module === undefined && to.modulePattern === undefined;
  if (sites.length === 0 && files.length > 0 && targetsByFilesOnly) {
    return {
      sites,
      hint:
        '0 edges via `to.files` — that matches an import\'s DIRECTLY-resolved path, so a symbol ' +
        're-exported through a barrel/package resolves to the package entry, not the deep file. ' +
        'Target by `to.module` + `to.match` instead.',
    };
  }
  return { sites };
}
