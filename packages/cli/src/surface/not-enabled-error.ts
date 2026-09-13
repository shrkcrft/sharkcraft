import { flagBool, flagString, type ParsedArgs } from '../command-registry.ts';
import type { ISurfaceDenial } from './i-surface-denial.ts';
import { SurfaceLayer } from './surface-layer.ts';
import { SurfaceRefusalReason } from './surface-refusal-reason.ts';
import { TierSource } from './tier.ts';

/**
 * Structured error returned when a user / agent invokes a command the
 * surface gate refuses in the current repo: an experimental command not in
 * `sharkcraft.config.ts surface.enabled[]`, a tool-maintenance command
 * outside SharkCraft's own repository, or a command a `surface.disabled`
 * selector denies.
 *
 * Exit code distinguishes "command exists but is gated" from
 * "command unknown" (which exits 2 via the did-you-mean path in
 * main.ts) and from any check verdict (0/1/2) — a gated command is never a
 * check failure.
 */
export const SURFACE_NOT_ENABLED_EXIT_CODE = 78;

export const SURFACE_NOT_ENABLED_SCHEMA = 'sharkcraft.surface.not-enabled.v1';

export interface ISurfaceNotEnabledError {
  schema: typeof SURFACE_NOT_ENABLED_SCHEMA;
  command: string;
  tier: 'experimental';
  /** Why the gate refused (round 11): `experimental` · `tool-maintenance` · `disabled`. */
  reasonCode: SurfaceRefusalReason;
  reason: string;
  enableCommand: string;
  explainCommand: string;
}

/** A view the gate may refuse — the fields of `ISurfaceCommandView` the refusal reads. */
interface IGatedView {
  readonly command: string;
  readonly source: string;
  readonly detail?: string;
  readonly deniedBy?: ISurfaceDenial;
}

export function makeSurfaceNotEnabledError(
  command: string,
  options: { reason?: string } = {},
): ISurfaceNotEnabledError {
  return {
    schema: SURFACE_NOT_ENABLED_SCHEMA,
    command,
    tier: 'experimental',
    reasonCode: SurfaceRefusalReason.Experimental,
    reason:
      options.reason ??
      `Command \`${command}\` is an experimental tier — not enabled in this repo.`,
    enableCommand: `shrk surface enable ${shellWord(command)}`,
    explainCommand: `shrk surface explain ${shellWord(command)}`,
  };
}

/**
 * THE refusal for a non-callable surface view. The CLI surface gate renders
 * it (exit 78) and the MCP gate sends its reason, so both name the same cause
 * and the same remedy.
 */
export function surfaceRefusalFor(view: IGatedView): ISurfaceNotEnabledError {
  const explainCommand = `shrk surface explain ${shellWord(view.command)}`;
  if (view.source === TierSource.ToolMaintenance) {
    return {
      schema: SURFACE_NOT_ENABLED_SCHEMA,
      command: view.command,
      tier: 'experimental',
      reasonCode: SurfaceRefusalReason.ToolMaintenance,
      reason: `\`${view.command}\` maintains SharkCraft itself and does not apply to this repository — this is not a check failure.`,
      enableCommand: `shrk surface enable ${shellWord(view.command)} --write`,
      explainCommand,
    };
  }
  if (view.source === TierSource.Disabled && view.deniedBy) {
    const { selector, origin } = view.deniedBy;
    const byConfig = origin === SurfaceLayer.Config;
    return {
      schema: SURFACE_NOT_ENABLED_SCHEMA,
      command: view.command,
      tier: 'experimental',
      reasonCode: SurfaceRefusalReason.Disabled,
      reason: `\`${view.command}\` is disabled in this repository by ${
        byConfig ? `surface.disabled ('${selector}')` : `the active surface profile ('${selector}')`
      } — this is not a check failure.`,
      // A config deny is undone where it was declared; a profile deny is
      // overridden by an explicit config enable.
      enableCommand: byConfig
        ? `shrk surface allow ${shellWord(selector)} --write`
        : `shrk surface enable ${shellWord(view.command)} --write`,
      explainCommand,
    };
  }
  return makeSurfaceNotEnabledError(view.command, view.detail ? { reason: view.detail } : {});
}

export function renderSurfaceNotEnabledText(
  err: ISurfaceNotEnabledError,
): string {
  const lines: string[] = [];
  switch (err.reasonCode) {
    case SurfaceRefusalReason.ToolMaintenance:
      lines.push(err.reason);
      lines.push('');
      lines.push(
        "It checks SharkCraft's own sources (its docs set, examples, release artifacts or command catalog), " +
          'so it is gated outside the SharkCraft repository.',
      );
      lines.push('');
      lines.push('To run it anyway:');
      lines.push(`  $ ${err.enableCommand}`);
      lines.push('');
      lines.push('Why it is gated:');
      lines.push(`  $ ${err.explainCommand}`);
      lines.push('');
      return lines.join('\n');
    case SurfaceRefusalReason.Disabled:
      lines.push(err.reason);
      lines.push('');
      lines.push('To allow it again:');
      lines.push(`  $ ${err.enableCommand}`);
      lines.push('');
      lines.push('Why it is gated:');
      lines.push(`  $ ${err.explainCommand}`);
      lines.push('');
      return lines.join('\n');
    case SurfaceRefusalReason.Experimental:
      break;
  }
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

/**
 * THE writer of a CLI surface refusal — which stream gets which form. A caller
 * that asked for the machine form (`--json`, or `--format json`) gets the
 * structured refusal (`schema` + `reasonCode`) on STDOUT, the channel every
 * `--json` body uses, and stderr stays empty; otherwise the text goes to
 * STDERR and stdout stays empty. (The docs promised the JSON body; the gate
 * printed the text alone, so an agent branching on `reasonCode` got nothing.)
 */
export function surfaceRefusalOutput(
  err: ISurfaceNotEnabledError,
  args: ParsedArgs,
): { readonly stdout: string; readonly stderr: string } {
  const json = flagBool(args, 'json') || flagString(args, 'format') === 'json';
  return json
    ? { stdout: `${JSON.stringify(err, null, 2)}\n`, stderr: '' }
    : { stdout: '', stderr: renderSurfaceNotEnabledText(err) };
}

/** A command path / selector as ONE shell word: quoted when it holds a space or a glob. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9._/:=@-]+$/.test(value) ? value : JSON.stringify(value);
}
