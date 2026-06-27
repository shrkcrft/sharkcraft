import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPublishPkg,
  discoverPackages,
  matchPackage,
  topoSort,
  versionsByName,
  withPublishMode,
  type IPackageJson,
} from '../lib/publish-mode.ts';

function pkg(name: string, deps: Record<string, string> = {}): IPackageJson {
  return {
    name,
    version: '0.1.0-alpha.2',
    main: './src/index.ts',
    types: './src/index.ts',
    exports: { '.': './src/index.ts' },
    files: ['src'],
    dependencies: deps,
  };
}

describe('buildPublishPkg', () => {
  test('rewrites main/types/exports/bin from src/.ts to dist/.{js,d.ts}', () => {
    const orig: IPackageJson = {
      ...pkg('@x/a'),
      bin: { x: './src/main.ts' },
    };
    const out = buildPublishPkg(orig, new Map());
    expect(out.main).toBe('./dist/index.js');
    expect(out.types).toBe('./dist/index.d.ts');
    expect(out.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        default: './dist/index.js',
      },
    });
    expect(out.bin).toEqual({ x: './dist/main.js' });
  });

  test('is idempotent on dual-runtime package.json (types already ./dist/*.d.ts)', () => {
    // Committed package.json files use the dual-runtime shape: main/types
    // point at ./dist already, with `bun` resolving to ./src. Rewriting must
    // not double-suffix the .d.ts into .d.d.ts.
    const orig: IPackageJson = {
      name: '@x/dual',
      version: '0.1.0-alpha.2',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          bun: './src/index.ts',
          import: './dist/index.js',
          default: './dist/index.js',
        },
      },
      files: ['dist'],
    };
    const out = buildPublishPkg(orig, new Map());
    expect(out.main).toBe('./dist/index.js');
    expect(out.types).toBe('./dist/index.d.ts');
  });

  test('files is overridden to dist/README/LICENSE (no src)', () => {
    const orig = { ...pkg('@x/a'), files: ['src'] };
    const out = buildPublishPkg(orig, new Map());
    expect(out.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });

  test('replaces workspace:* internal pins with ^<version>', () => {
    const orig = pkg('@x/b', {
      '@shrkcrft/core': 'workspace:*',
      '@shrkcrft/templates': 'workspace:^',
      lodash: '^4.0.0',
    });
    const versionByName = new Map<string, string>([
      ['@shrkcrft/core', '0.1.0-alpha.2'],
      ['@shrkcrft/templates', '0.1.0-alpha.2'],
    ]);
    const out = buildPublishPkg(orig, versionByName);
    expect(out.dependencies).toEqual({
      '@shrkcrft/core': '^0.1.0-alpha.2',
      '@shrkcrft/templates': '^0.1.0-alpha.2',
      lodash: '^4.0.0',
    });
  });

  test('leaves non-sharkcraft and non-workspace pins untouched', () => {
    const orig = pkg('@x/c', {
      '@shrkcrft/core': '^0.1.0-alpha.2',
      zod: '^3.0.0',
    });
    const out = buildPublishPkg(orig, new Map([['@shrkcrft/core', '0.1.0-alpha.2']]));
    expect(out.dependencies?.['@shrkcrft/core']).toBe('^0.1.0-alpha.2');
    expect(out.dependencies?.zod).toBe('^3.0.0');
  });

  test('publishPinExact drops the caret on listed deps and is stripped from output', () => {
    const orig: IPackageJson = {
      ...pkg('shrk', {
        '@shrkcrft/cli': 'workspace:*',
        '@shrkcrft/core': 'workspace:*',
      }),
      publishPinExact: ['@shrkcrft/cli'],
    } as IPackageJson;
    const versionByName = new Map<string, string>([
      ['@shrkcrft/cli', '0.1.0-alpha.6'],
      ['@shrkcrft/core', '0.1.0-alpha.6'],
    ]);
    const out = buildPublishPkg(orig, versionByName);
    expect(out.dependencies?.['@shrkcrft/cli']).toBe('0.1.0-alpha.6');
    expect(out.dependencies?.['@shrkcrft/core']).toBe('^0.1.0-alpha.6');
    expect((out as { publishPinExact?: unknown }).publishPinExact).toBeUndefined();
  });
});

describe('withPublishMode', () => {
  test('restores package.json after a successful run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-pm-ok-'));
    try {
      const pkgPath = join(dir, 'package.json');
      const orig = pkg('@x/ok');
      writeFileSync(pkgPath, JSON.stringify(orig, null, 2), 'utf8');
      const swappedSnapshot = await withPublishMode(dir, new Map(), () => {
        return JSON.parse(readFileSync(pkgPath, 'utf8'));
      });
      expect(swappedSnapshot.main).toBe('./dist/index.js');
      const after = JSON.parse(readFileSync(pkgPath, 'utf8'));
      expect(after.main).toBe('./src/index.ts');
      expect(existsSync(join(dir, 'package.json.bak'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restores package.json even when the body throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-pm-throw-'));
    try {
      const pkgPath = join(dir, 'package.json');
      const orig = pkg('@x/throw');
      writeFileSync(pkgPath, JSON.stringify(orig, null, 2), 'utf8');
      let threw = false;
      try {
        await withPublishMode(dir, new Map(), () => {
          throw new Error('boom');
        });
      } catch (e) {
        threw = true;
        expect((e as Error).message).toBe('boom');
      }
      expect(threw).toBe(true);
      const after = JSON.parse(readFileSync(pkgPath, 'utf8'));
      expect(after.main).toBe('./src/index.ts');
      expect(after.files).toEqual(['src']);
      expect(existsSync(join(dir, 'package.json.bak'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('discoverPackages + topoSort + matchPackage', () => {
  function setupRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'shrk-discover-'));
    const packagesDir = join(root, 'packages');
    mkdirSync(packagesDir, { recursive: true });
    function makePkg(short: string, name: string, deps: string[] = [], privateFlag = false): void {
      const pkgDir = join(packagesDir, short);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify(
          {
            name,
            version: '0.1.0-alpha.2',
            private: privateFlag,
            dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
          },
          null,
          2,
        ),
      );
    }
    makePkg('core', '@shrkcrft/core');
    makePkg('knowledge', '@shrkcrft/knowledge', ['@shrkcrft/core']);
    makePkg('rules', '@shrkcrft/rules', ['@shrkcrft/core', '@shrkcrft/knowledge']);
    makePkg('cli', '@shrkcrft/cli', ['@shrkcrft/rules']);
    makePkg('private-thing', '@shrkcrft/internal', [], true);
    return packagesDir;
  }

  test('discovers public packages, skips private ones via filter', () => {
    const dir = setupRepo();
    try {
      const packages = discoverPackages(dir);
      const publicPackages = packages.filter((p) => !p.private);
      expect(packages.find((p) => p.short === 'private-thing')?.private).toBe(true);
      expect(publicPackages.map((p) => p.short).sort()).toEqual(
        ['cli', 'core', 'knowledge', 'rules'].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('topoSort puts leaves first, consumers last', () => {
    const dir = setupRepo();
    try {
      const ordered = topoSort(discoverPackages(dir).filter((p) => !p.private));
      const order = ordered.map((p) => p.short);
      // core has no internal deps → first
      expect(order[0]).toBe('core');
      // cli depends on rules transitively → last
      expect(order[order.length - 1]).toBe('cli');
      // rules comes after knowledge
      expect(order.indexOf('rules')).toBeGreaterThan(order.indexOf('knowledge'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('matchPackage accepts short and full names', () => {
    const dir = setupRepo();
    try {
      const packages = discoverPackages(dir).filter((p) => !p.private);
      expect(matchPackage(packages, 'cli')?.name).toBe('@shrkcrft/cli');
      expect(matchPackage(packages, '@shrkcrft/cli')?.short).toBe('cli');
      expect(matchPackage(packages, 'nope')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('versionsByName', () => {
  test('keys are full names, values are versions', () => {
    const v = versionsByName([
      { short: 'a', name: '@x/a', version: '1.0.0', dir: '/x/a', deps: [], private: false },
      { short: 'b', name: '@x/b', version: '2.0.0', dir: '/x/b', deps: [], private: false },
    ]);
    expect(v.get('@x/a')).toBe('1.0.0');
    expect(v.get('@x/b')).toBe('2.0.0');
  });
});
