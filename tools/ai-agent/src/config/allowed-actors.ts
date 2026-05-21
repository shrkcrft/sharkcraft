/**
 * GitHub logins permitted to open `[AI]`-titled issues that the AI agent
 * workflow will act on automatically.
 *
 * Read from the `SHARKCRAFT_AI_ALLOWED_ACTORS` environment variable
 * (comma-separated). Set this in CI as a repo variable or in
 * `.env.local` for local dev — it is intentionally *not* hardcoded in
 * source so the OSS repo never ships a specific maintainer handle.
 *
 * Empty default means "no one is allowed" — the gate will deny every
 * `opened` event until the env var is configured.
 */
export function getAllowedActors(): readonly string[] {
  const raw = process.env['SHARKCRAFT_AI_ALLOWED_ACTORS'] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
