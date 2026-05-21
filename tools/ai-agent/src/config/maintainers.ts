/**
 * GitHub logins permitted to apply the `ai:plan` / `ai:implement`
 * labels that route the AI agent into plan / implement mode.
 *
 * Read from the `SHARKCRAFT_AI_MAINTAINERS` environment variable
 * (comma-separated). Same rationale as `allowed-actors.ts` — kept out
 * of source so the OSS repo doesn't ship a specific maintainer handle.
 */
export function getMaintainers(): readonly string[] {
  const raw = process.env['SHARKCRAFT_AI_MAINTAINERS'] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
