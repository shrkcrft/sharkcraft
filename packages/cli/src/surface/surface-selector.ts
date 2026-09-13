/**
 * THE surface selector matcher (round 11 §5.1#3) — the one answer to "does
 * this `surface.hidden` / `surface.enabled` / `surface.disabled` entry name
 * this command?". The tier resolver, the surface summary (flags + the
 * unknown-selector warnings) and `surface deny` all read it, so a selector can
 * never hide a command in one place and miss it in another.
 *
 *   - an exact command path, or one of its alias spellings: `bundle list`
 *   - a GROUP selector — a path followed by ` *`: `bundle *` names `bundle`
 *     itself and every command below it (`bundle list`, `bundle replay …`)
 *
 * Back-compat is exact: no pre-round-11 selector ends in ` *`, and an exact
 * selector still names exactly one path. A bare `*` is not a group selector
 * (it names no command, so the summary warns `unknown-command`).
 */
export const GROUP_SELECTOR_SUFFIX = ' *';

/** True for `<path> *` (a non-empty path followed by ` *`). */
export function isGroupSelector(selector: string): boolean {
  const s = selector.trim();
  return s.endsWith(GROUP_SELECTOR_SUFFIX) && s.slice(0, -GROUP_SELECTOR_SUFFIX.length).trim().length > 0;
}

/** Does `selector` name `command` (a path or an alias spelling)? */
export function matchesSurfaceSelector(selector: string, command: string): boolean {
  const want = selector.trim();
  const name = command.trim();
  if (isGroupSelector(want)) {
    const group = want.slice(0, -GROUP_SELECTOR_SUFFIX.length).trim();
    return name === group || name.startsWith(`${group} `);
  }
  return name === want;
}

/**
 * The first selector in `selectors` that names any of `names` (a command path
 * plus its alias spellings), or `undefined`.
 */
export function firstMatchingSelector(
  selectors: readonly string[] | undefined,
  names: readonly string[],
): string | undefined {
  for (const selector of selectors ?? []) {
    if (names.some((n) => matchesSurfaceSelector(selector, n))) return selector;
  }
  return undefined;
}
