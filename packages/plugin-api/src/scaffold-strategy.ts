/**
 * THE one table of scaffold-pattern variable-extraction strategies.
 *
 * "Which strategies exist" and "what each one yields" used to be two lists kept
 * in sync by hand: a recognised-name set here and an if/else chain in the
 * inspector. They disagreed silently the moment someone added a name to one of
 * them. Both now read this table: `isRecognizedScaffoldStrategy(s)` is
 * `resolveScaffoldStrategy(s, sample).recognized`, and the inspector's
 * extractor calls `resolveScaffoldStrategy` directly.
 *
 * Pure string transforms — no IO, no pack code.
 */

/** What a strategy reads: the file's basename (no extension), its parent directory name, and the nearest package name. */
export interface IScaffoldStrategyContext {
  /** File basename WITHOUT its extension, e.g. `UserProfileService` or `user-profile.service`. */
  readonly basename: string;
  /** Name of the file's parent directory (last segment), e.g. `user-profile`. */
  readonly directory: string;
  /** Nearest `package.json` name, when known. */
  readonly packageName?: string;
}

function kebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_+/g, '-')
    .toLowerCase();
}

function pascal(s: string): string {
  return s
    .split(/[-_.]/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
}

function camel(s: string): string {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : '';
}

function stripSuffix(value: string, suffix: string): string {
  return suffix.length > 0 && value.length > suffix.length && value.endsWith(suffix)
    ? value.slice(0, -suffix.length)
    : value;
}

/** Strategies named exactly. */
const EXACT_STRATEGIES: Readonly<Record<string, (ctx: IScaffoldStrategyContext) => string>> = {
  'filename.kebab': (ctx) => kebab(ctx.basename),
  'filename.pascal': (ctx) => pascal(ctx.basename),
  className: (ctx) => pascal(ctx.basename),
  functionName: (ctx) => camel(ctx.basename),
  directoryName: (ctx) => ctx.directory,
  'directoryName.kebab': (ctx) => kebab(ctx.directory),
  'directoryName.pascal': (ctx) => pascal(ctx.directory),
  nearestPackageName: (ctx) => ctx.packageName ?? '',
};

/** Strategies that carry an argument after a `:` (e.g. `className.stripSuffix:Service`). */
const PARAMETERISED_STRATEGIES: Readonly<
  Record<string, (ctx: IScaffoldStrategyContext, arg: string) => string>
> = {
  'className.stripPrefix:': (ctx, prefix) => {
    const name = pascal(ctx.basename);
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  },
  'className.stripSuffix:': (ctx, suffix) => stripSuffix(pascal(ctx.basename), suffix),
  'filename.stripSuffix:': (ctx, suffix) => stripSuffix(ctx.basename, suffix),
};

/** Every exact strategy name, in table order. */
export const EXACT_SCAFFOLD_STRATEGY_NAMES: readonly string[] = Object.freeze(Object.keys(EXACT_STRATEGIES));

/** Every parameterised strategy prefix (`<name>:`), in table order. */
export const PARAMETERISED_SCAFFOLD_STRATEGY_PREFIXES: readonly string[] = Object.freeze(
  Object.keys(PARAMETERISED_STRATEGIES),
);

/**
 * Resolve one strategy against a file. `recognized: false` means the name is
 * not in the table (the caller reports it); a recognised strategy may still
 * yield an empty value (e.g. `nearestPackageName` with no package name).
 */
export function resolveScaffoldStrategy(
  strategy: string,
  ctx: IScaffoldStrategyContext,
): { readonly recognized: boolean; readonly value?: string } {
  const exact = EXACT_STRATEGIES[strategy];
  if (exact) return { recognized: true, value: exact(ctx) };
  for (const prefix of PARAMETERISED_SCAFFOLD_STRATEGY_PREFIXES) {
    if (strategy.startsWith(prefix)) {
      return { recognized: true, value: PARAMETERISED_STRATEGIES[prefix]!(ctx, strategy.slice(prefix.length)) };
    }
  }
  return { recognized: false };
}

/** The fixed sample the recognised-name check resolves against. */
export const SCAFFOLD_STRATEGY_SAMPLE: IScaffoldStrategyContext = Object.freeze({
  basename: 'UserProfileService',
  directory: 'user-profile',
  packageName: '@sample/package',
});
