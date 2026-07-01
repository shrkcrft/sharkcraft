import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wiringCommand } from '../commands/wiring.command.ts';

const CANDIDATE = {
  id: 'demo.use-must-register',
  declared: { files: ['src/**/*.ts'], pattern: "use\\('([^']+)'\\)" },
  registered: { files: ['registry/**/*.ts'], pattern: "register\\('([^']+)'\\)" },
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-wiring-cmd-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'registry'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), "use('alpha')\nuse('beta')\n");
  writeFileSync(join(root, 'registry', 'r.ts'), "register('alpha')\n");
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

describe('shrk wiring test', () => {
  test('dry-runs an inline candidate against the live tree (no config write)', async () => {
    const root = fixture();
    try {
      const cap = capture();
      const code = await wiringCommand.run(args(root, ['test', JSON.stringify(CANDIDATE)]));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.schema).toBe('sharkcraft.wiring-explain/v1');
      expect(json.declared.distinctCount).toBe(2);
      expect(json.registered.distinctCount).toBe(1);
      expect(json.declaredNotRegistered.map((s: { token: string }) => s.token)).toEqual(['beta']);
      expect(json.verdict).toBe('errors');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a candidate missing required fields', async () => {
    const root = fixture();
    try {
      const cap = capture();
      const code = await wiringCommand.run(args(root, ['test', JSON.stringify({ id: 'x' })]));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(2);
      expect(json.ok).toBe(false);
      expect(typeof json.error).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed JSON', async () => {
    const root = fixture();
    try {
      const cap = capture();
      const code = await wiringCommand.run(args(root, ['test', '{not json']));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(2);
      expect(json.ok).toBe(false);
      expect(json.error).toContain('valid JSON');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unknown subverb returns a usage error', async () => {
    const root = fixture();
    try {
      const code = await wiringCommand.run(args(root, ['frobnicate']));
      expect(code).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
