import {
  buildAcceptanceReplay,
  buildChangesSummary,
  ReplayProfile,
} from '@shrkcrft/inspector';
import type { IToolDefinition } from '../server/tool-definition.ts';

export const getAcceptanceReplayTool: IToolDefinition = {
  name: 'get_acceptance_replay',
  description:
    'Acceptance-command replay: given a change set, lists previous validation commands to re-run, with reasons. Read-only — does NOT execute the commands.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'string', description: 'Diff base (git ref / tag).' },
      staged: { type: 'boolean' },
      files: { type: 'array', items: { type: 'string' } },
      profile: { type: 'string', enum: ['changed-only', 'standard', 'strict'] },
      roundLabel: { type: 'string' },
    },
    additionalProperties: false,
  },
  async handler(input, ctx) {
    const since = typeof (input as { since?: unknown }).since === 'string'
      ? (input as { since: string }).since
      : undefined;
    const staged = (input as { staged?: unknown }).staged === true;
    const filesIn = (input as { files?: unknown }).files;
    const files = Array.isArray(filesIn)
      ? (filesIn as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const profileRaw = typeof (input as { profile?: unknown }).profile === 'string'
      ? (input as { profile: string }).profile
      : 'changed-only';
    const profile: ReplayProfile =
      profileRaw === 'standard'
        ? ReplayProfile.Standard
        : profileRaw === 'strict'
          ? ReplayProfile.Strict
          : ReplayProfile.ChangedOnly;
    const roundLabel = typeof (input as { roundLabel?: unknown }).roundLabel === 'string'
      ? (input as { roundLabel: string }).roundLabel
      : undefined;
    const opts: {
      since?: string;
      staged?: boolean;
      files?: readonly string[];
      roundLabel?: string;
    } = {};
    if (since) opts.since = since;
    if (staged) opts.staged = true;
    if (files && files.length > 0) opts.files = files;
    if (roundLabel) opts.roundLabel = roundLabel;
    const summary = await buildChangesSummary(ctx.inspection, opts);
    const data = buildAcceptanceReplay({
      summary,
      profile,
      ...(roundLabel ? { roundLabel } : {}),
    });
    return { data };
  },
};
