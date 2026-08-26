import { describe, expect, test } from 'bun:test';
import type { IWiringSource } from '@shrkcrft/core';
import { extractTokens } from '../extract/extract-tokens.ts';
import type { ITsconfigPathsMap } from '../scan/tsconfig-aliases.ts';

/**
 * The `import-edges` extractor — the dependency graph as a rule input.
 *
 * Every other extractor reads file CONTENTS, so alias-resolved dependency
 * DIRECTION was inexpressible as a rule and repos hand-rolled scripts for it.
 * These assert the four shapes it unlocks (ledger, orphans, ratchet, fence) and,
 * just as importantly, that it never claims an edge the text does not support.
 */

const FILES = [
  { path: 'apps/a.ts', content: "import { NgeAlphaView } from '@x/generated';\nexport const a = NgeAlphaView;\n" },
  {
    path: 'apps/b.ts',
    content:
      "import { NgeBetaView, NgeAlphaView } from '@x/generated';\nimport { helper } from './helper';\nexport const b = 1;\n",
  },
  { path: 'apps/helper.ts', content: 'export const helper = 1;\n' },
];

/** A tsconfig map mapping `@x/generated` at `src/generated`. */
const ALIASES: ITsconfigPathsMap = {
  baseUrl: '.',
  aliases: new Map([
    ['@x/generated', ['src/generated/index.ts']],
    ['@x/generated/*', ['src/generated/*']],
  ]),
  sources: [],
} as unknown as ITsconfigPathsMap;

function ids(source: IWiringSource, files = FILES, tsconfigPaths?: ITsconfigPathsMap): string[] {
  const res = extractTokens(source, files, tsconfigPaths ? { tsconfigPaths } : {});
  expect(res.error).toBeUndefined();
  return [...new Set(res.sites.map((s) => s.token))].sort();
}

describe('import-edges — targeting', () => {
  test('`module` selects a package and its subpaths, never a lookalike', () => {
    const files = [
      { path: 'a.ts', content: "import { X } from '@x/generated';\n" },
      { path: 'b.ts', content: "import { Y } from '@x/generated/views';\n" },
      { path: 'c.ts', content: "import { Z } from '@x/generated-legacy';\n" },
    ];
    expect(ids({ files: ['*.ts'], extract: 'import-edges', to: { module: '@x/generated' } }, files)).toEqual([
      'a.ts → X',
      'b.ts → Y',
    ]);
  });

  test('`match` narrows to specific SYMBOLS within the matched module', () => {
    expect(
      ids({ files: ['apps/**'], extract: 'import-edges', to: { module: '@x/generated', match: '^NgeAlpha' } }),
    ).toEqual(['apps/a.ts → NgeAlphaView', 'apps/b.ts → NgeAlphaView']);
  });

  test('a module hit whose symbols all fail `match` is NOT an edge', () => {
    // The rule asked about specific symbols; reporting the module anyway would
    // be answering a question that was not posed.
    expect(
      ids({ files: ['apps/**'], extract: 'import-edges', to: { module: '@x/generated', match: '^Nothing$' } }),
    ).toEqual([]);
  });

  test('`files` matches the RESOLVED target of a relative specifier', () => {
    expect(ids({ files: ['apps/**'], extract: 'import-edges', to: { files: ['apps/helper.ts'] } })).toEqual([
      'apps/b.ts → helper',
    ]);
  });

  test('an alias specifier resolves through the tsconfig paths map', () => {
    // Without the map the specifier is a bare package; with it, the same import
    // is recognised as pointing into `src/generated`.
    const source: IWiringSource = {
      files: ['apps/**'],
      extract: 'import-edges',
      to: { files: ['src/generated/**'] },
    };
    expect(ids(source)).toEqual([]);
    expect(ids(source, FILES, ALIASES)).toEqual([
      'apps/a.ts → NgeAlphaView',
      'apps/b.ts → NgeAlphaView',
      'apps/b.ts → NgeBetaView',
    ]);
  });
});

describe('import-edges — emit modes carry the four rule shapes', () => {
  const to = { module: '@x/generated' } as const;

  test('`edge` (default) pins from→symbol — the adoption ledger / fence shape', () => {
    expect(ids({ files: ['apps/**'], extract: 'import-edges', to })).toEqual([
      'apps/a.ts → NgeAlphaView',
      'apps/b.ts → NgeAlphaView',
      'apps/b.ts → NgeBetaView',
    ]);
  });

  test('`symbol` yields bare names — the orphan-detection shape', () => {
    expect(ids({ files: ['apps/**'], extract: 'import-edges', to, emit: 'symbol' })).toEqual([
      'NgeAlphaView',
      'NgeBetaView',
    ]);
  });

  test('`from` yields importing files — the deprecation-ratchet shape', () => {
    expect(ids({ files: ['apps/**'], extract: 'import-edges', to, emit: 'from' })).toEqual([
      'apps/a.ts',
      'apps/b.ts',
    ]);
  });

  test('the id set is order-insensitive and stable, so a ledger diff reads cleanly', () => {
    const forward = ids({ files: ['apps/**'], extract: 'import-edges', to });
    const reversed = ids({ files: ['apps/**'], extract: 'import-edges', to }, [...FILES].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe('import-edges — honest about what the text says', () => {
  test('a re-export is an edge too — a barrel that hid its consumers would hide the graph', () => {
    const files = [{ path: 'barrel.ts', content: "export { X } from '@x/generated';\n" }];
    expect(ids({ files: ['*.ts'], extract: 'import-edges', to: { module: '@x/generated' } }, files)).toEqual([
      'barrel.ts → X',
    ]);
  });

  test('a side-effect import is reported against the module it names', () => {
    const files = [{ path: 'a.ts', content: "import '@x/generated/register';\n" }];
    expect(ids({ files: ['*.ts'], extract: 'import-edges', to: { module: '@x/generated' } }, files)).toEqual([
      'a.ts → @x/generated/register',
    ]);
  });

  test('a DYNAMIC import is an edge — a fence that missed it would have a hole', () => {
    const files = [{ path: 'a.ts', content: "const m = await import('@x/generated/late');\n" }];
    expect(ids({ files: ['*.ts'], extract: 'import-edges', to: { module: '@x/generated' } }, files)).toEqual([
      'a.ts → @x/generated/late',
    ]);
  });

  test('a require() call is an edge too', () => {
    const files = [{ path: 'a.ts', content: "const m = require('@x/generated');\n" }];
    expect(ids({ files: ['*.ts'], extract: 'import-edges', to: { module: '@x/generated' } }, files)).toEqual([
      'a.ts → @x/generated',
    ]);
  });

  test('a static import is counted ONCE, not also as a side-effect match', () => {
    // `import { X } from 'y'` contains the text `import … 'y'`; double-counting
    // it would inflate every ledger by the number of named imports.
    const files = [{ path: 'a.ts', content: "import { X } from '@x/generated';\n" }];
    const res = extractTokens(
      { files: ['*.ts'], extract: 'import-edges', to: { module: '@x/generated' } },
      files,
    );
    expect(res.sites).toHaveLength(1);
  });

  test('an ALIASED import reports the EXPORTED name, not the local one', () => {
    // A ledger keyed by the local alias would drift the moment a consumer
    // renamed its own binding, which says nothing about the dependency.
    const files = [{ path: 'a.ts', content: "import { NgeAlphaView as V } from '@x/generated';\n" }];
    expect(ids({ files: ['*.ts'], extract: 'import-edges', to: { module: '@x/generated' } }, files)).toEqual([
      'a.ts → NgeAlphaView',
    ]);
  });

  test('a rule with no `to` selector is refused rather than pinning every import', () => {
    const res = extractTokens({ files: ['apps/**'], extract: 'import-edges' }, FILES);
    expect(res.sites).toEqual([]);
    expect(res.error).toContain('requires a `to` selector');
  });

  test('an uncompilable symbol pattern is an error, never a silent empty set', () => {
    const res = extractTokens(
      { files: ['apps/**'], extract: 'import-edges', to: { module: '@x/generated', match: '(' } },
      FILES,
    );
    expect(res.error).toBeDefined();
  });
});

describe('filenames — the companion-file invariant', () => {
  const files = [
    { path: 'src/ALPHA_DESCRIPTOR.ts', content: '' },
    { path: 'src/nested/BETA_DESCRIPTOR.tsx', content: '' },
  ];

  test('`stem` (default) drops the extension — the shape that pairs a file with a const', () => {
    expect(ids({ files: ['src/**'], extract: 'filenames' }, files)).toEqual([
      'ALPHA_DESCRIPTOR',
      'BETA_DESCRIPTOR',
    ]);
  });

  test('`basename` keeps it', () => {
    expect(ids({ files: ['src/**'], extract: 'filenames', capturePath: 'basename' }, files)).toEqual([
      'ALPHA_DESCRIPTOR.ts',
      'BETA_DESCRIPTOR.tsx',
    ]);
  });

  test('`regex` captures from the whole PATH, so a directory can key the id', () => {
    expect(
      ids(
        { files: ['src/**'], extract: 'filenames', capturePath: 'regex', pathPattern: '([A-Z]+)_DESCRIPTOR' },
        files,
      ),
    ).toEqual(['ALPHA', 'BETA']);
  });

  test('a multi-dot filename keeps everything after the FIRST dot as extension', () => {
    // `a.tool.ts` stems to `a`, which is what pairs it with an `a` id — taking
    // the last dot would yield `a.tool` and silently never match.
    expect(ids({ files: ['**'], extract: 'filenames' }, [{ path: 'src/a.tool.ts', content: '' }])).toEqual(['a']);
  });
});

describe('import-edges — the barrel trap explains itself', () => {
  /** A consumer importing through a barrel that re-exports from `generated/`. */
  const CONSUMER = [
    { path: 'apps/consumer.ts', content: "import { NgeCardView } from '@x/ui';\n" },
  ];
  const UI_ALIAS: ITsconfigPathsMap = {
    baseUrl: '.',
    aliases: new Map([['@x/ui', ['libs/ui/index.ts']]]),
    sources: [],
  } as unknown as ITsconfigPathsMap;

  test('to.files yields 0 edges for a barrel import — correct, but not what was meant', () => {
    const res = extractTokens(
      { files: ['apps/**'], extract: 'import-edges', to: { files: ['**/generated/**'] } },
      CONSUMER,
      { tsconfigPaths: UI_ALIAS },
    );
    expect(res.sites).toEqual([]);
    // …so the zero-match carries its own diagnosis rather than leaving the
    // author to rediscover why a technically-correct rule found nothing.
    expect(res.hint).toContain('DIRECTLY-resolved path');
    expect(res.hint).toContain('`to.module`');
  });

  test('to.module + match returns the real edges', () => {
    expect(
      ids({ files: ['apps/**'], extract: 'import-edges', to: { module: '@x/ui', match: 'View$' } }, CONSUMER, UI_ALIAS),
    ).toEqual(['apps/consumer.ts → NgeCardView']);
  });

  test('no hint when to.files legitimately matches — the barrel own re-exports resolve', () => {
    // Inside the library the re-export is a RELATIVE import, so `to.files` is
    // exactly the right tool there. Hinting here would be wrong advice.
    const barrel = [
      { path: 'libs/ui/index.ts', content: "export { NgeCardView } from './generated/NgeCardView';\n" },
    ];
    const res = extractTokens(
      { files: ['libs/**'], extract: 'import-edges', to: { files: ['**/generated/**'] } },
      barrel,
    );
    expect(res.sites).toHaveLength(1);
    expect(res.hint).toBeUndefined();
  });

  test('no hint when the FROM glob matched nothing — that is a different problem', () => {
    // A stale `files` glob needs "your scan set is empty", not "use to.module".
    const res = extractTokens(
      { files: ['moved/**'], extract: 'import-edges', to: { files: ['**/generated/**'] } },
      [],
    );
    expect(res.hint).toBeUndefined();
  });

  test('no hint when the rule targets by module and simply matched nothing', () => {
    const res = extractTokens(
      { files: ['apps/**'], extract: 'import-edges', to: { module: '@x/nope' } },
      CONSUMER,
      { tsconfigPaths: UI_ALIAS },
    );
    expect(res.sites).toEqual([]);
    expect(res.hint).toBeUndefined();
  });
});

describe('import-edges — the hint never gives wrong advice', () => {
  test('no hint when the rule ALREADY targets by module', () => {
    // "Use to.module instead" to someone already using it is worse than
    // silence: it sends them to re-check a thing that is not the problem.
    const res = extractTokens(
      {
        files: ['apps/**'],
        extract: 'import-edges',
        to: { module: '@x/nope', files: ['**/generated/**'] },
      },
      [{ path: 'apps/a.ts', content: "import { X } from '@x/ui';\n" }],
    );
    expect(res.sites).toEqual([]);
    expect(res.hint).toBeUndefined();
  });

  test('no hint when the rule targets by modulePattern alongside files', () => {
    const res = extractTokens(
      {
        files: ['apps/**'],
        extract: 'import-edges',
        to: { modulePattern: '^@nope/', files: ['**/generated/**'] },
      },
      [{ path: 'apps/a.ts', content: "import { X } from '@x/ui';\n" }],
    );
    expect(res.hint).toBeUndefined();
  });
});
