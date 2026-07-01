import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import { wiringCommand } from '../commands/wiring.command.ts';

/**
 * A workspace whose sharkcraft.config.ts declares a DI idiom over an
 * InjectionToken-style codebase. Patterns avoid backslashes (use `[A-Za-z]+` /
 * `inject[(]…`) so the embedded config string stays readable.
 *   - ApiToken:   declared + provided + consumed → wired.
 *   - DbToken:    declared + provided, not consumed → orphan.
 *   - GhostToken: declared + consumed, not provided → unprovided.
 */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-reg-cli-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reg-ws', version: '0.0.0' }));
  const skDir = join(root, 'sharkcraft');
  mkdirSync(skDir, { recursive: true });
  writeFileSync(
    join(skDir, 'sharkcraft.config.ts'),
    `export default {
  registrationGraph: [
    {
      name: 'di',
      declared: { files: ['src/**/*.ts'], pattern: 'export const ([A-Za-z]+) = new InjectionToken' },
      provided: { files: ['src/**/*.ts'], arrayProperty: 'providers' },
      consumed: { files: ['src/**/*.ts'], pattern: 'inject[(]([A-Za-z]+)' },
    },
  ],
};
`,
  );
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'tokens.ts'),
    "export const ApiToken = new InjectionToken('api');\n" +
      "export const DbToken = new InjectionToken('db');\n" +
      "export const GhostToken = new InjectionToken('ghost');\n",
  );
  writeFileSync(join(root, 'src', 'module.ts'), 'const providers = [ApiToken, DbToken];\n');
  writeFileSync(
    join(root, 'src', 'service.ts'),
    'const a = inject(ApiToken);\nconst g = inject(GhostToken);\n',
  );
  return root;
}

function args(root: string, positional: string[]): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ['json', true]]),
    multiFlags: new Map(),
  };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

describe('shrk wiring chain|unprovided|orphans (registration graph)', () => {
  beforeEach(() => clearPackDiscoveryCache());

  test('unprovided finds the declared/injected-but-never-provided token (exit 1)', async () => {
    const root = makeWorkspace();
    try {
      const cap = capture();
      const code = await wiringCommand.run(args(root, ['unprovided']));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(json.unprovided.map((u: { token: string }) => u.token)).toEqual(['GhostToken']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('orphans finds the provided-but-never-consumed token (exit 0, advisory)', async () => {
    const root = makeWorkspace();
    try {
      const cap = capture();
      const code = await wiringCommand.run(args(root, ['orphans']));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.orphans.map((o: { token: string }) => o.token)).toEqual(['DbToken']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('chain reports declared → provided → consumed for a wired token', async () => {
    const root = makeWorkspace();
    try {
      const cap = capture();
      const code = await wiringCommand.run(args(root, ['chain', 'ApiToken']));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.isDeclared && json.isProvided && json.isConsumed).toBe(true);
      expect(json.declared[0].file).toBe('src/tokens.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('chain on an unknown token exits 1', async () => {
    const root = makeWorkspace();
    try {
      const cap = capture();
      const code = await wiringCommand.run(args(root, ['chain', 'NoSuchToken']));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(json.error).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('caches the scan by graph digest — a second query reuses it, same result', async () => {
    const root = makeWorkspace();
    try {
      // A built graph index activates the digest cache.
      buildFullIndex({ projectRoot: root });
      const cachePath = join(root, '.sharkcraft', 'cache', 'registration-graph.json');

      const cap1 = capture();
      await wiringCommand.run(args(root, ['unprovided']));
      const first = JSON.parse(cap1.restore());
      expect(existsSync(cachePath)).toBe(true); // scan cached after the first query

      const cap2 = capture();
      await wiringCommand.run(args(root, ['unprovided']));
      const second = JSON.parse(cap2.restore());
      // Cache hit → identical result.
      expect(second.unprovided.map((u: { token: string }) => u.token)).toEqual(
        first.unprovided.map((u: { token: string }) => u.token),
      );
      expect(second.unprovided.map((u: { token: string }) => u.token)).toEqual(['GhostToken']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
