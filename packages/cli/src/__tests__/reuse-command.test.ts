import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IReusePrimitive } from '@shrkcrft/core';
import { buildFullIndex } from '@shrkcrft/graph';
import { reuseCommand, rankReuseSuggestions } from '../commands/reuse.command.ts';

function setup(withGraph: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-reuse-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'button.ts'),
    'export class AppButton {}\nexport function buttonHelper() { return 1; }\nfunction _localOnly() { return 2; }\n',
  );
  writeFileSync(
    join(root, 'src', 'page.ts'),
    "import { AppButton } from './button';\nexport function makePage() {\n  return new AppButton();\n}\n",
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.0' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {
  reusePrimitives: [
    { symbol: 'AppButton', roles: ['button', 'clickable control'], importPath: '@demo/ui', description: 'The shared button primitive.' },
  ],
};\n`,
  );
  if (withGraph) buildFullIndex({ projectRoot: root });
  return root;
}

function makeArgs(positional: string[], cwd: string, extra?: Record<string, string | boolean>) {
  const flags = new Map<string, string | boolean>();
  flags.set('cwd', cwd);
  flags.set('json', true);
  for (const [k, v] of Object.entries(extra ?? {})) flags.set(k, v);
  return { positional, flags, multiFlags: new Map<string, string[]>() };
}

/** A temp project whose config declares `count` fake reuse primitives. */
function setupMany(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-reuse-many-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.0' }));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  const prims = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return `    { symbol: 'Prim${n}', roles: ['role${n}', 'group${n}'], keywords: ['kw${n}'] }`;
  }).join(',\n');
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {\n  reusePrimitives: [\n${prims}\n  ],\n};\n`,
  );
  return root;
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

describe('shrk reuse', () => {
  test('intent → primitive, resolved through the graph to import path + siblings + consumers', async () => {
    const root = setup(true);
    try {
      const cap = capture();
      const code = await reuseCommand.run(makeArgs(['I', 'want', 'to', 'add', 'a', 'button'], root));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(out.results.length).toBeGreaterThan(0);
      const top = out.results[0];
      expect(top.symbol).toBe('AppButton');
      expect(top.importLine).toBe("import { AppButton } from '@demo/ui';");
      expect(top.declaredIn).toBe('src/button.ts');
      expect(top.siblings).toContain('buttonHelper');
      expect(top.siblings).not.toContain('_localOnly'); // exported-only siblings
      // The `new AppButton()` reference is surfaced as a consumer to copy.
      expect(top.consumers.map((c: { path: string }) => c.path)).toContain('src/page.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('nonsense intent → ranked top-K suggestions (not the full catalog); --all reveals the catalog', async () => {
    const root = setupMany(12);
    try {
      // No shared term with any primitive: every candidate scores 0.
      const cap = capture();
      const code = await reuseCommand.run(makeArgs(['quantum', 'flux', 'capacitor'], root));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(out.results).toEqual([]);
      expect(out.confident).toBe(false);
      // Capped at the default K (5) — NOT the full 12-entry catalog.
      expect(Array.isArray(out.suggestions)).toBe(true);
      expect(out.suggestions.length).toBe(5);
      expect(out.suggestions.length).toBeLessThan(12);
      // Every suggestion row carries a (numeric) score.
      for (const s of out.suggestions) expect(typeof s.score).toBe('number');
      // Full catalog stays behind --all.
      expect(out.availableRoles).toBeUndefined();

      const cap2 = capture();
      await reuseCommand.run(makeArgs(['quantum', 'flux', 'capacitor'], root, { all: true }));
      const out2 = JSON.parse(cap2.restore());
      expect(Array.isArray(out2.availableRoles)).toBe(true);
      expect(out2.availableRoles.length).toBe(24); // 12 primitives × 2 roles each
      expect(out2.suggestions.length).toBe(5); // suggestions still capped
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--limit N caps the did-you-mean suggestion list', async () => {
    const root = setupMany(12);
    try {
      const cap = capture();
      await reuseCommand.run(makeArgs(['quantum', 'flux'], root, { limit: '3' }));
      const out = JSON.parse(cap.restore());
      expect(out.suggestions.length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rankReuseSuggestions: capped, score-sorted, each row carries a score', () => {
    const primitives: IReusePrimitive[] = Array.from({ length: 12 }, (_, i) => ({
      symbol: `Prim${i + 1}`,
      roles: [`role${i + 1}`],
      keywords: [`kw${i + 1}`],
    }));
    // Nonsense intent → no shared term → every score is 0.
    const nonsense = rankReuseSuggestions(primitives, ['zzz', 'qqq'], 5);
    expect(nonsense.length).toBe(5); // capped at K, not the full 12
    for (const s of nonsense) {
      expect(typeof s.score).toBe('number');
      expect(s.score).toBe(0);
    }
    // Ties broken by symbol name → deterministic, alphabetical.
    expect(nonsense.map((s) => s.symbol)).toEqual([
      'Prim1', 'Prim10', 'Prim11', 'Prim12', 'Prim2',
    ]);

    // A token that hits one primitive floats it to the top, score descending.
    const focused = rankReuseSuggestions(primitives, ['role7', 'zzz'], 3);
    expect(focused.length).toBe(3);
    expect(focused[0]!.symbol).toBe('Prim7');
    expect(focused[0]!.score).toBeGreaterThan(0);
    for (let i = 1; i < focused.length; i += 1) {
      expect(focused[i]!.score).toBeLessThanOrEqual(focused[i - 1]!.score);
    }
  });

  test('weak single-keyword overlap → no confident match + did-you-mean, not a confident answer', async () => {
    const root = setup(true);
    try {
      const cap = capture();
      // 'clickable' hits AppButton's role only (not its symbol name); a lone
      // keyword collision on a 3-token intent is below the confidence floor.
      const code = await reuseCommand.run(makeArgs(['clickable', 'widget', 'thing'], root));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(out.results).toEqual([]);
      expect(out.confident).toBe(false);
      expect(out.didYouMean.length).toBeGreaterThan(0);
      expect(out.didYouMean[0].symbol).toBe('AppButton');
      // The score is exposed so a caller can judge the match strength.
      expect(typeof out.didYouMean[0].score).toBe('number');
      expect(out.didYouMean[0].confidence).toBeLessThan(1);
      // The canonical `suggestions` key mirrors the legacy `didYouMean` alias.
      expect(out.suggestions).toEqual(out.didYouMean);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('confident match exposes score/confidence and a labeled consumer total', async () => {
    const root = setup(true);
    try {
      const cap = capture();
      const code = await reuseCommand.run(makeArgs(['I', 'want', 'to', 'add', 'a', 'button'], root));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      const top = out.results[0];
      expect(top.symbol).toBe('AppButton');
      expect(typeof top.score).toBe('number');
      expect(top.confidence).toBeGreaterThan(0);
      expect(top.matched).toContain('button');
      // The consumer denominator is exposed (1 real consumer: src/page.ts).
      expect(top.consumerTotal).toBe(1);
      expect(top.consumerTotal).toBe(top.consumers.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('graph indexed but symbol absent → notFound flag (not a silent blank)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-reuse-missing-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1;\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'd', version: '0.0.0' }));
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      writeFileSync(
        join(root, 'sharkcraft', 'sharkcraft.config.ts'),
        "export default { reusePrimitives: [{ symbol: 'GhostButton', roles: ['button'] }] };\n",
      );
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      await reuseCommand.run(makeArgs(['add', 'a', 'button'], root));
      const out = JSON.parse(cap.restore());
      expect(out.results[0].symbol).toBe('GhostButton');
      expect(out.results[0].notFound).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('same-named declarations: prefers exported, discloses alternates, no broken import line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-reuse-ambig-'));
    try {
      mkdirSync(join(root, 'src', 'a'), { recursive: true });
      mkdirSync(join(root, 'src', 'b'), { recursive: true });
      // Two exported `Widget` declarations in different files.
      writeFileSync(join(root, 'src', 'a', 'widget.ts'), 'export class Widget {}\n');
      writeFileSync(join(root, 'src', 'b', 'widget.ts'), 'export class Widget {}\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'd', version: '0.0.0' }));
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      // No importPath configured → no import line should be fabricated.
      writeFileSync(
        join(root, 'sharkcraft', 'sharkcraft.config.ts'),
        "export default { reusePrimitives: [{ symbol: 'Widget', roles: ['widget'] }] };\n",
      );
      buildFullIndex({ projectRoot: root });
      const cap = capture();
      await reuseCommand.run(makeArgs(['add', 'a', 'widget'], root));
      const out = JSON.parse(cap.restore());
      const top = out.results[0];
      expect(top.symbol).toBe('Widget');
      // Deterministic pick = shallowest/sorted path; the other is disclosed.
      expect(top.declaredIn).toBe('src/a/widget.ts');
      expect(top.alternates).toContain('src/b/widget.ts');
      // No importPath in config → no fabricated (broken) import line.
      expect(top.importLine).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('without a graph index, still returns the configured primitive + import path', async () => {
    const root = setup(false);
    try {
      const cap = capture();
      await reuseCommand.run(makeArgs(['add', 'a', 'button'], root));
      const out = JSON.parse(cap.restore());
      expect(out.graphIndexed).toBe(false);
      expect(out.results[0].symbol).toBe('AppButton');
      expect(out.results[0].importLine).toBe("import { AppButton } from '@demo/ui';");
      // No graph → no resolved consumers/siblings.
      expect(out.results[0].consumers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
