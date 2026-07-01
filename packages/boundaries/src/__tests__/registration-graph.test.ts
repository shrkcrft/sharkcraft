import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IRegistrationIdiom } from '@shrkcrft/core';
import {
  REGISTRATION_GRAPH_SCHEMA,
  buildRegistrationGraph,
  registrationChain,
  registrationGraphSignature,
  registrationOrphans,
  registrationUnprovided,
} from '../wiring/registration-graph.ts';

const IDIOM: IRegistrationIdiom = {
  name: 'di',
  declared: { files: ['src/**/*.ts'], pattern: 'export const (\\w+) = new InjectionToken' },
  provided: { files: ['src/**/*.ts'], arrayProperty: 'providers' },
  consumed: { files: ['src/**/*.ts'], pattern: 'inject\\((\\w+)\\)' },
};

/**
 * - ApiToken:   declared + provided + consumed → wired.
 * - DbToken:    declared + provided, NOT consumed → orphan.
 * - GhostToken: declared + consumed, NOT provided → unprovided (silent at runtime).
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-reg-graph-'));
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

describe('buildRegistrationGraph', () => {
  test('buckets declared / provided / consumed sites by token', () => {
    const root = fixture();
    try {
      const graph = buildRegistrationGraph(root, [IDIOM]);
      expect(graph.schema).toBe(REGISTRATION_GRAPH_SCHEMA);
      expect(graph.idioms).toEqual(['di']);
      const tokens = graph.tokens.map((t) => t.token).sort();
      expect(tokens).toEqual(['ApiToken', 'DbToken', 'GhostToken']);

      const api = graph.tokens.find((t) => t.token === 'ApiToken')!;
      expect(api.declared.length).toBe(1);
      expect(api.provided.length).toBe(1);
      expect(api.consumed.length).toBe(1);
      expect(api.declared[0]!.file).toBe('src/tokens.ts');
      expect(api.consumed[0]!.file).toBe('src/service.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('registrationChain reports role-presence flags', () => {
    const root = fixture();
    try {
      const graph = buildRegistrationGraph(root, [IDIOM]);
      const api = registrationChain(graph, 'ApiToken')!;
      expect(api.isDeclared && api.isProvided && api.isConsumed).toBe(true);
      const ghost = registrationChain(graph, 'GhostToken')!;
      expect(ghost.isProvided).toBe(false);
      expect(registrationChain(graph, 'NoSuchToken')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('registrationUnprovided finds the declared/injected-but-not-provided token', () => {
    const root = fixture();
    try {
      const graph = buildRegistrationGraph(root, [IDIOM]);
      const unprovided = registrationUnprovided(graph).map((u) => u.token);
      expect(unprovided).toEqual(['GhostToken']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('registrationOrphans finds the provided-but-not-consumed token', () => {
    const root = fixture();
    try {
      const graph = buildRegistrationGraph(root, [IDIOM]);
      const orphans = registrationOrphans(graph).map((o) => o.token);
      expect(orphans).toEqual(['DbToken']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a misconfigured idiom source degrades to a diagnostic, never throws', () => {
    const root = fixture();
    try {
      const graph = buildRegistrationGraph(root, [
        { ...IDIOM, declared: { files: ['src/**/*.ts'], pattern: 'export const \\w+' } },
      ]);
      expect(graph.diagnostics.join(' ')).toContain('capture group');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('registrationGraphSignature', () => {
  test('is stable across reads and shifts when a matched file changes', () => {
    const root = fixture();
    try {
      const before = registrationGraphSignature(root, [IDIOM]);
      // Re-signing the same unchanged files is deterministic.
      expect(registrationGraphSignature(root, [IDIOM])).toBe(before);

      // Edit a matched source file (add a token → different byte length, so the
      // signature shifts even where mtime resolution is coarse). Critically, NO
      // code-graph reindex is performed: because the signature tracks the graph's
      // real data source, the persisted wiring cache can never go stale.
      writeFileSync(
        join(root, 'src', 'tokens.ts'),
        "export const ApiToken = new InjectionToken('api');\n" +
          "export const DbToken = new InjectionToken('db');\n" +
          "export const GhostToken = new InjectionToken('ghost');\n" +
          "export const NewToken = new InjectionToken('new');\n",
      );
      expect(registrationGraphSignature(root, [IDIOM])).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('computes from files alone — no code-graph index required', () => {
    const root = fixture();
    try {
      // No `.sharkcraft/graph` store exists; the signature still computes.
      expect(registrationGraphSignature(root, [IDIOM])).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
