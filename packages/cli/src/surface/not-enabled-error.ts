/**
 * Structured error returned when a user / agent invokes an
 * experimental command that is not enabled in the current repo's
 * `sharkcraft.config.ts surface.enabled[]`.
 *
 * Exit code distinguishes "command exists but is gated" from
 * "command unknown" (which exits 2 via the did-you-mean path in
 * main.ts).
 */
export const SURFACE_NOT_ENABLED_EXIT_CODE = 78;

export const SURFACE_NOT_ENABLED_SCHEMA = 'sharkcraft.surface.not-enabled.v1';

export interface ISurfaceNotEnabledError {
  schema: typeof SURFACE_NOT_ENABLED_SCHEMA;
  command: string;
  tier: 'experimental';
  reason: string;
  enableCommand: string;
  explainCommand: string;
}

export function makeSurfaceNotEnabledError(
  command: string,
  options: { reason?: string } = {},
): ISurfaceNotEnabledError {
  return {
    schema: SURFACE_NOT_ENABLED_SCHEMA,
    command,
    tier: 'experimental',
    reason:
      options.reason ??
      `Command \`${command}\` is an experimental tier — not enabled in this repo.`,
    enableCommand: `shrk surface enable ${command}`,
    explainCommand: `shrk surface explain ${command}`,
  };
}

export function renderSurfaceNotEnabledText(
  err: ISurfaceNotEnabledError,
): string {
  const lines: string[] = [];
  lines.push(`Command \`${err.command}\` exists but is not enabled in this repo.`);
  lines.push('');
  lines.push(`It is tier=${err.tier}. ${err.reason}`);
  lines.push('');
  lines.push('Enable it:');
  lines.push(`  $ ${err.enableCommand}`);
  lines.push('');
  lines.push('Or see why it is gated:');
  lines.push(`  $ ${err.explainCommand}`);
  lines.push('');
  return lines.join('\n');
}
