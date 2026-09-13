import {
  extractGlobalCompress,
  extractGlobalCwd,
  extractGlobalExitTrailer,
  type CommandRegistry,
  type IGlobalCompressDirective,
} from '../command-registry.ts';

/**
 * The dispatcher's GLOBAL flags — accepted by every command, anywhere before
 * the `--` sentinel: leading (`shrk --no-hints scaffolds list`), between the
 * path tokens (`shrk scaffolds --no-hints list`) or trailing
 * (`shrk scaffolds list --no-hints`).
 *
 * `--cwd`, `--exit-trailer` and the `--compress*` family are stripped from the
 * argv before dispatch; `--strict` (also a per-command flag) and `--no-hints`
 * reach the handler; `--help` / `-h` are intercepted before any body runs. The
 * declared-flag guard accepts every one of them on top of a handler's own set,
 * and the post-run read-tracking detector never judges them.
 */
export const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  'cwd',
  'strict',
  'no-hints',
  'exit-trailer',
  'compress',
  'ccr',
  'compress-type',
  'compress-query',
  'help',
  'h',
]);

/**
 * The global flags that take a VALUE — `--cwd <dir>`, `--compress-type <t>`,
 * `--compress-query <q>` (or the `--flag=value` form). A subset of
 * {@link GLOBAL_FLAGS}; the pre-dispatch strip removes each with its value.
 */
export const GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(['cwd', 'compress-type', 'compress-query']);

/**
 * Presentation-only flags. An unread one is still WARNED about, but it never
 * changes the exit: ignoring `--json` or `--verbose` loses formatting, not an
 * input the verdict depended on. (`-v` is the short `--verbose`.)
 */
export const SOFT_FLAGS: ReadonlySet<string> = new Set([
  'json',
  'verbose',
  'v',
  'quiet',
  'no-color',
  'color',
]);

/**
 * A global flag the trie descent steps OVER instead of stopping at — while it
 * sits inside the command path. Before round 11 a leading `--no-hints` /
 * `--strict` ended the descent at the first token, so `shrk --no-hints
 * scaffolds list` reported "shrk doesn't have a `scaffolds list` command" and
 * `shrk --strict doctor` suggested `shrk doctor`. The descent hoists these into
 * the handler's argv (before any `--`), so the handler still sees its own
 * `--strict`.
 */
export function isPathTransparentGlobal(token: string): boolean {
  return token === '--no-hints' || token === '--strict' || token.startsWith('--strict=');
}

/**
 * A path-transparent global flag that may take the NEXT token as its value:
 * the bare `--strict` (`doctor --strict warnings` reads `warnings` as the
 * level). The descent steps over it only while the path continues after it;
 * past the path it stays in front of its value, never turning the value into a
 * positional. `--strict=<level>` and `--no-hints` are self-contained.
 */
export function bindsFollowingValue(token: string): boolean {
  return token === '--strict';
}

/**
 * The global flags `runCliInner` strips from ANYWHERE before dispatch
 * (`extractGlobalCwd`, `extractGlobalCompress`, `extractGlobalExitTrailer`):
 * every global except the path-transparent ones, which reach the handler, and
 * `--help` / `-h`, which the help intercept answers. The command-string
 * resolver strips exactly these, so a documented `shrk --cwd x doctor` and the
 * real dispatch read the same command.
 */
export const STRIPPED_GLOBAL_FLAGS: ReadonlySet<string> = new Set(
  [...GLOBAL_FLAGS].filter((f) => f !== 'help' && f !== 'h' && !isPathTransparentGlobal(`--${f}`)),
);

/**
 * THE pre-dispatch strip: `--cwd`, `--exit-trailer` and the `--compress*`
 * family ({@link STRIPPED_GLOBAL_FLAGS}) removed from anywhere before `--`, in
 * the one order both readers use. `runCliInner` dispatches from `rest`, and
 * `runCli` derives the verdict path (the pipe note, `--exit-trailer`, the usage
 * record) from the SAME `rest` — before this, `runCli` stripped only `--cwd` and
 * `--exit-trailer`, so a leading `--compress` ended the descent at the first
 * token and `shrk --compress check wiring --exit-trailer` printed no trailer.
 */
export function stripPreDispatchGlobals(argv: readonly string[]): {
  readonly cwd?: string;
  readonly trailer: boolean;
  readonly compress?: IGlobalCompressDirective;
  readonly rest: string[];
} {
  const { cwd, rest: afterCwd } = extractGlobalCwd(argv);
  const { trailer, rest: afterTrailer } = extractGlobalExitTrailer(afterCwd);
  const { directive, rest } = extractGlobalCompress(afterTrailer);
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    trailer,
    ...(directive !== undefined ? { compress: directive } : {}),
    rest,
  };
}

/**
 * Flags every command accepts implicitly — left out of an "Accepts:" list.
 * `--strict` stays listed: it is also a per-command flag with its own meaning
 * (`check --strict`).
 */
export const IMPLICIT_FLAGS: ReadonlySet<string> = new Set([...GLOBAL_FLAGS].filter((f) => f !== 'strict'));

/**
 * THE trie-descent options for the dispatcher's global flags. `runCliInner`'s
 * descent and {@link withoutPathGlobals} (the verdict path and the usage
 * record) both pass exactly this, so they cannot disagree about where the
 * command path ends.
 */
export const PATH_TRANSPARENCY = {
  transparent: isPathTransparentGlobal,
  bindsValue: bindsFollowingValue,
} as const;

/**
 * `argv` as the dispatcher reads it: the command path first — spelled as
 * typed, the path-transparent global flags stepped over exactly as the trie
 * descent steps over them — then everything else. The view `extractCommandPath`
 * needs: a leading `--no-hints` does not zero out the verdict path (and with it
 * `--exit-trailer`), and `doctor --strict warnings` keeps `warnings` as the
 * value of `--strict`, never a path segment.
 */
export function withoutPathGlobals(argv: readonly string[], registry: CommandRegistry): string[] {
  const resolution = registry.resolve(argv, PATH_TRANSPARENCY);
  return [...resolution.matchedTokens, ...resolution.rest];
}
