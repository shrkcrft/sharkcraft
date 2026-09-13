/**
 * r76 — ONE loader-kind → contribution-kind table (round 12 review, R12-X4).
 *
 * There were three copies: the rejection channel's, the contributions
 * report's (its By-file rows) and `packs contributions`' (the `--kind` filter
 * that feeds the exit). The CLI copy lacked `knowledge` / `docs` and gave the
 * right answer only because those loader names happen to equal their
 * contribution kinds — two code paths agreeing by coincidence. Every reader
 * now maps through `contributionKindOfLoader`; this lock holds the table to
 * THE `LoaderAssetKind` union and forbids a private copy.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContributionKind } from '../contribution-kind.ts';
import { contributionKindOfLoader, LOADER_ASSET_KIND_CONTRIBUTION } from '../contribution-load-failures.ts';

const PACKAGES = join(import.meta.dir, '..', '..', '..');

/** The `LoaderAssetKind` union members, read from its declaration (a type cannot be iterated). */
function loaderAssetKinds(): string[] {
  const text = readFileSync(join(PACKAGES, 'inspector/src/inspector-cache.ts'), 'utf8');
  const start = text.indexOf('export type LoaderAssetKind =');
  expect(start).toBeGreaterThanOrEqual(0);
  const body = text.slice(start, text.indexOf(';', start));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe('R12-X4 — contributionKindOfLoader is THE table', () => {
  test('every LoaderAssetKind has a row, and every row maps to a real contribution kind', () => {
    const kinds = loaderAssetKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(LOADER_ASSET_KIND_CONTRIBUTION).sort()).toEqual([...kinds].sort());
    const values = new Set<string>(Object.values(ContributionKind));
    for (const k of kinds) {
      const mapped = contributionKindOfLoader(k);
      expect({ k, mapped, real: mapped !== undefined && values.has(mapped) }).toEqual({ k, mapped, real: true });
    }
    // The plural loader names land on their singular kinds (the CLI copy's six), and the two
    // names that coincide with their kinds (knowledge, docs) map through the table too.
    expect(contributionKindOfLoader('rules')).toBe(ContributionKind.Rule);
    expect(contributionKindOfLoader('boundaries')).toBe(ContributionKind.Boundary);
    expect(contributionKindOfLoader('knowledge')).toBe(ContributionKind.Knowledge);
    expect(contributionKindOfLoader('docs')).toBe(ContributionKind.Docs);
  });

  test('a registry loader already reports its contribution kind — it maps to itself; an unknown kind is undefined', () => {
    for (const k of Object.values(ContributionKind)) expect(contributionKindOfLoader(k)).toBe(k);
    expect(contributionKindOfLoader('not-a-loader')).toBeUndefined();
  });

  test('no reader keeps a private copy of the table', () => {
    for (const rel of ['inspector/src/contributions-report.ts', 'cli/src/commands/packs.command.ts', 'inspector/src/contribution-load-failures.ts']) {
      const text = readFileSync(join(PACKAGES, rel), 'utf8');
      expect({ rel, oldTable: /LOADER_KIND_TO_CONTRIBUTION_KIND|const LOADER_KIND\b/.test(text) }).toEqual({ rel, oldTable: false });
      expect({ rel, reads: text.includes('contributionKindOfLoader') }).toEqual({ rel, reads: true });
    }
  });
});
