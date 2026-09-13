/**
 * The FALLBACK safety classification of a recommended command — for a surface
 * with no command catalog (MCP `recommend_commands`, which cannot import the
 * CLI) and for uncatalogued / free-text strings. The CLI injects the catalog's
 * DECLARED per-command safety into the ranker (`safetyOf`, see
 * `IRecommendationRankingOptions`), which wins over this regex; a lock
 * (r75-safety-one-authority) holds this regex equal to the catalog on every
 * row the catalog's own audit counts as writing source, so the not-confident
 * withhold gate reads the same answer on both surfaces.
 *
 * A `shrk` invocation behind a package-manager prefix is classified by the
 * `shrk` verb, never as a shell command.
 */
export function commandSafetyLevel(
  command: string,
): 'read-only' | 'writes-drafts' | 'writes-session' | 'writes-source' | 'runs-shell' {
  const c = command
    .trim()
    .replace(/^\$\s+/, '')
    .replace(/^(?:bun run|bun x|bunx|npx|pnpm exec|pnpm|yarn)\s+(?=shrk\b)/i, '');
  if (/^shrk delegate(?:\s|$)/i.test(c)) return 'writes-source';
  if (
    /^shrk (?:gen|init|apply|import|migrate|spike|presets apply --write|packs (?:sign|new)|(?:baseline|generated) update)(?:\s|$)/i.test(
      c,
    )
  ) {
    return 'writes-source';
  }
  // `surface` and its config-mutating verbs write sharkcraft.config.ts; `surface
  // list` / `explain` / `profiles` read.
  if (/^shrk surface(?:\s+(?:enable|disable|hide|unhide|deny|allow|reset)(?:\s|$)|\s*$)/i.test(c)) return 'writes-source';
  // `check wiring --fix` edits sink files; plain `check wiring` reads.
  if (/^shrk check wiring\b.*\s--fix(?:\s|=|$)/i.test(c)) return 'writes-source';
  // The base GitHub workflow scaffold writes source; its `--with-*` variants
  // are declared drafts-only (the catalog rows), which the rule below keeps.
  if (/^shrk ci scaffold github-actions(?:\s|$)/i.test(c) && !/\s--with-/i.test(c)) return 'writes-source';
  if (/^shrk (?:onboard|brief|dev start|handoff|export|report site|impact|ci scaffold|simulate|orchestrate|spec)\b/i.test(c)) {
    return 'writes-drafts';
  }
  if (/^shrk (?:session|dev report)\b/i.test(c)) return 'writes-session';
  if (/^(?:bun|bunx|npm|npx|pnpm|yarn|node|git|nx) /i.test(c)) return 'runs-shell';
  return 'read-only';
}
