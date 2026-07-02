import { SHARKCRAFT_VERSION } from '@shrkcrft/shared';
import {
  flagBool,
  flagString,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';
import { RELEASE_SURFACE_DELTAS, type IReleaseSurfaceDelta } from './changelog-data.ts';

/** Parse `X.Y.Z[-alpha.N]` into a comparable tuple. A release outranks its prerelease. */
function parseVersion(v: string): { core: [number, number, number]; pre: number } {
  const [coreStr, preStr] = v.replace(/^v/, '').split('-');
  const parts = (coreStr ?? '').split('.').map((n) => Number(n) || 0);
  const core: [number, number, number] = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  // No prerelease sorts ABOVE any prerelease of the same core; a prerelease
  // sorts by its trailing number (alpha.24 < alpha.25).
  let pre = Number.POSITIVE_INFINITY;
  if (preStr) {
    const m = preStr.match(/(\d+)/);
    pre = m ? Number(m[1]) : 0;
  }
  return { core, pre };
}

/** -1 / 0 / 1 comparator over version strings. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  return pa.pre < pb.pre ? -1 : 1;
}

function renderDeltaText(d: IReleaseSurfaceDelta): string {
  const lines: string[] = [`\n${d.version} — ${d.title}`];
  const section = (label: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push(`  ${label}:`);
    for (const it of items) lines.push(`    • ${it}`);
  };
  section('Added', d.added);
  section('Changed', d.changed);
  section('Removed', d.removed);
  return lines.join('\n') + '\n';
}

export const changelogCommand: ICommandHandler = {
  name: 'changelog',
  description:
    "The shrk command-surface delta of the running build — which verbs/flags were added, changed, or removed. Sourced from an in-binary release-notes asset (offline, authoritative for this exact build). `--since <version>` shows the cumulative delta since a prior version.",
  usage: 'shrk changelog [--since <version>] [--all] [--json]',
  booleanFlags: new Set(['all', 'json']),
  run(args: ParsedArgs): number {
    const wantJson = flagBool(args, 'json');
    const since = flagString(args, 'since');
    const all = flagBool(args, 'all');
    const current = SHARKCRAFT_VERSION;

    // Newest-first for display.
    const sorted = [...RELEASE_SURFACE_DELTAS].sort((a, b) => compareVersions(b.version, a.version));

    let selected: IReleaseSurfaceDelta[];
    let scope: string;
    if (all) {
      selected = sorted;
      scope = 'all recorded versions';
    } else if (since) {
      // Cumulative delta: every recorded version strictly newer than `since`.
      selected = sorted.filter((d) => compareVersions(d.version, since) > 0);
      scope = `since ${since}`;
    } else {
      // Default: the entry matching the running build, else the newest recorded.
      const exact = sorted.find((d) => compareVersions(d.version, current) === 0);
      selected = exact ? [exact] : sorted.slice(0, 1);
      scope = exact ? `running build (${current})` : `latest recorded (running build ${current} has no recorded surface delta)`;
    }

    if (wantJson) {
      process.stdout.write(
        asJson({
          schema: 'sharkcraft.changelog/v1',
          runningVersion: current,
          scope,
          ...(since ? { since } : {}),
          count: selected.length,
          versions: selected,
        }) + '\n',
      );
      return 0;
    }

    process.stdout.write(header(`shrk changelog — ${scope}`));
    if (selected.length === 0) {
      process.stdout.write(
        since
          ? `  No recorded surface changes since ${since}.\n`
          : '  No recorded surface changes.\n',
      );
      return 0;
    }
    for (const d of selected) process.stdout.write(renderDeltaText(d));
    if (!all && !since) {
      process.stdout.write('\n(pass --since <version> for the cumulative delta, or --all for every recorded version.)\n');
    }
    return 0;
  },
};
