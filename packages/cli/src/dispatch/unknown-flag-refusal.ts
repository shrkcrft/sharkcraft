import { misreadValueHint, spellFlagAsTyped } from '../command-registry.ts';
import { closestMatches } from './closest-match.ts';
import type { IInvocationRejection } from './invocation-rejection.ts';
import { InvocationRejectionKind } from './invocation-rejection-kind.ts';
import type { IUnknownFlagRefusalInput } from './i-unknown-flag-refusal-input.ts';
import { UnknownFlagRefusalMode } from './unknown-flag-refusal-mode.ts';

/**
 * THE wording of a refused flag (round 13) — one format on every path that
 * refuses one:
 *
 *   ! `shrk gates check`: --fail-on-dead-units is not a flag of this command. Did you mean --allow-empty?
 *     Accepts: --json, --margin, …            (only when the command declares its complete flag set)
 *     Refused before anything ran — a result that ignored --fail-on-dead-units would not be a pass (exit 3). Run `shrk help gates check` for the flags it accepts.
 *
 * There were two: the declared-flag guard printed `Unknown flag "--x" for
 * \`shrk gates check\`. Accepts: …` while the documentation refusal printed
 * `! \`shrk policy-lint\`: --x is not a flag of this command.` — two refusal
 * paths for one judgement (`judgeInvocation`), and `check boundaries` / `reuse
 * coverage` kept a third inside their bodies. Every one now builds its message
 * here; only the closing sentence says WHEN (the {@link UnknownFlagRefusalMode}):
 * before the run, or after a run that ignored the flag. A flag a sibling
 * subverb documents says which (`— only \`shrk check boundaries\` documents
 * it`). A `--offset -1` misread names the flag the number was meant for.
 */
export function unknownFlagRefusal(input: IUnknownFlagRefusalInput): IInvocationRejection {
  const closest: string[] = [];
  let message = '';
  for (const key of input.flags) {
    const misread = misreadValueHint(key, input.argv);
    const near = misread === undefined ? closestMatches(key, input.known, 1)[0] : undefined;
    if (near !== undefined) closest.push(`shrk ${input.label} --${near}`);
    const owners = input.documentedOn?.[key] ?? [];
    const only =
      owners.length > 0 ? ` — only ${owners.map((p) => `\`shrk ${p}\``).join(' and ')} document${owners.length > 1 ? '' : 's'} it` : '';
    message +=
      misread !== undefined
        ? `! \`shrk ${input.label}\`: ${misread}.\n`
        : `! \`shrk ${input.label}\`: ${spellFlagAsTyped(key, input.argv)} is not a flag of this command${only}.` +
          `${near !== undefined ? ` Did you mean --${near}?` : ''}\n`;
  }
  if (input.accepts !== undefined && input.accepts.length > 0) {
    message += `  Accepts: ${input.accepts.map((f) => `--${f}`).join(', ')}.\n`;
  }
  const spelled = input.flags.map((key) => spellFlagAsTyped(key, input.argv)).join(', ');
  const help = `Run \`shrk help ${input.label}\` for the flags it accepts.`;
  const mode = input.mode ?? UnknownFlagRefusalMode.BeforeRun;
  message +=
    mode === UnknownFlagRefusalMode.BeforeRun
      ? `  Refused before anything ran — a result that ignored ${spelled} would not be a pass (exit ${input.exitCode}). ${help}\n`
      : mode === UnknownFlagRefusalMode.RefusedAfterRun
        ? `  The run ignored ${spelled}, so its result is refused — not a pass (exit ${input.exitCode}). ${help}\n`
        : `  The run ignored ${spelled} (exit ${input.exitCode} kept). ${help}\n`;
  return {
    message,
    exitCode: input.exitCode,
    kind: InvocationRejectionKind.UnknownFlag,
    ...(closest.length > 0 ? { closest } : {}),
  };
}
