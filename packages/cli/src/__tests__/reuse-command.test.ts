import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { reuseCommand } from '../commands/reuse.command.ts';

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

function makeArgs(positional: string[], cwd: string) {
  const flags = new Map<string, string | boolean>();
  flags.set('cwd', cwd);
  flags.set('json', true);
  return { positional, flags, multiFlags: new Map<string, string[]>() };
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

  test('non-matching intent returns no results + the available roles', async () => {
    const root = setup(true);
    try {
      const cap = capture();
      const code = await reuseCommand.run(makeArgs(['quantum', 'flux', 'capacitor'], root));
      const out = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(out.results).toEqual([]);
      expect(out.availableRoles).toContain('button');
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
