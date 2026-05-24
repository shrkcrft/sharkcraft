import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { defineArchContract } from '../contract/define-contract.ts';
import { runArchCheck } from '../checks/run-arch-check.ts';
import { ARCH_REPORT_SCHEMA } from '../schema/violation.ts';

function setupBaseFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-arch-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
  );
  for (const pkg of ['alpha', 'beta']) {
    mkdirSync(join(root, 'packages', pkg, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', pkg, 'package.json'),
      JSON.stringify({ name: `@demo/${pkg}`, main: 'src/index.ts' }, null, 2),
    );
  }
  return root;
}

describe('runArchCheck — generic checks', () => {
  test('public-api-misuse — flags cross-package import of a private file', () => {
    const root = setupBaseFixture();
    try {
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        "export { internalThing } from './internal.ts';",
      );
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'internal.ts'),
        "export const internalThing = 1;",
      );
      // beta reaches *past* the public entry — anti-pattern.
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "import { internalThing } from '@demo/alpha/src/internal.ts';\nexport const x = internalThing;",
      );
      buildFullIndex({ projectRoot: root });
      const r = runArchCheck({ projectRoot: root, enable: { publicApi: true, barrels: false, cycles: false } });
      expect(r.schema).toBe(ARCH_REPORT_SCHEMA);
      expect(r.violations.some((v) => v.kind === 'public-api-misuse')).toBe(true);
      const v = r.violations.find((v) => v.kind === 'public-api-misuse')!;
      expect(v.file).toBe('packages/beta/src/index.ts');
      expect(v.targetFile).toBe('packages/alpha/src/internal.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cycle — flags 2-node and 3-node cycles', () => {
    const root = setupBaseFixture();
    try {
      mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        "import { b } from './b.ts';\nexport const a = () => b();",
      );
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'b.ts'),
        "import { a } from './index.ts';\nexport const b = () => a();",
      );
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "export const beta = 1;",
      );
      buildFullIndex({ projectRoot: root });
      const r = runArchCheck({ projectRoot: root, enable: { cycles: true, publicApi: false, barrels: false } });
      expect(r.violations.some((v) => v.kind === 'cycle')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('barrel-fat — flags index.ts with many exports', () => {
    const root = setupBaseFixture();
    try {
      const lines: string[] = [];
      for (let i = 0; i < 50; i += 1) lines.push(`export const v${i} = ${i};`);
      writeFileSync(join(root, 'packages', 'alpha', 'src', 'index.ts'), lines.join('\n'));
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "export const beta = 1;",
      );
      buildFullIndex({ projectRoot: root });
      const r = runArchCheck({ projectRoot: root, enable: { barrels: true, publicApi: false, cycles: false } });
      expect(r.violations.some((v) => v.kind === 'barrel-fat')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('missing code-graph — diagnostic, no throw', () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-arch-empty-'));
    try {
      const r = runArchCheck({ projectRoot: root });
      expect(r.diagnostics.some((d) => d.includes('code-graph store missing'))).toBe(true);
      expect(r.violations.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('adapter-leak — flags controller importing repository directly', () => {
    const root = setupBaseFixture();
    try {
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        "export const alpha = 1;",
      );
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'users.controller.ts'),
        "import { UsersRepository } from './users.repository.ts';\nexport class UsersController { repo = new UsersRepository(); }",
      );
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'users.repository.ts'),
        "export class UsersRepository { findAll() { return []; } }",
      );
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "export const beta = 1;",
      );
      buildFullIndex({ projectRoot: root });
      const r = runArchCheck({
        projectRoot: root,
        enable: { adapterLeaks: true, publicApi: false, barrels: false, cycles: false },
      });
      const leak = r.violations.find((v) =>
        v.file === 'packages/alpha/src/users.controller.ts'
        && v.message.includes('adapter leak')
        && v.message.includes('controller'),
      );
      expect(leak).toBeDefined();
      expect(leak!.targetFile).toBe('packages/alpha/src/users.repository.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('defineArchContract + contract check', () => {
  test('mayNotImport detects a forbidden cross-layer edge', () => {
    const root = setupBaseFixture();
    try {
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        "export const alpha = 1;",
      );
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "import { alpha } from '@demo/alpha';\nexport const beta = alpha;",
      );
      buildFullIndex({ projectRoot: root });
      const contract = defineArchContract({
        id: 'demo.layers',
        layers: [
          { name: 'alpha', includes: ['packages/alpha/**'] },
          { name: 'beta', includes: ['packages/beta/**'] },
        ],
        rules: [
          { from: 'beta', mayNotImport: ['alpha'], severity: 'error', reason: 'beta is below alpha' },
        ],
      });
      const r = runArchCheck({
        projectRoot: root,
        contract,
        enable: { contract: true, publicApi: false, barrels: false, cycles: false },
      });
      expect(r.violations.some((v) => v.kind === 'contract-import')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mayImport whitelist flags non-listed layers', () => {
    const root = setupBaseFixture();
    try {
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        "export const alpha = 1;",
      );
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "import { alpha } from '@demo/alpha';\nexport const beta = alpha;",
      );
      buildFullIndex({ projectRoot: root });
      const contract = defineArchContract({
        layers: [
          { name: 'alpha', includes: ['packages/alpha/**'] },
          { name: 'beta', includes: ['packages/beta/**'] },
        ],
        rules: [
          // beta may NOT import anything (empty mayImport whitelist).
          { from: 'beta', mayImport: ['beta'] },
        ],
      });
      const r = runArchCheck({
        projectRoot: root,
        contract,
        enable: { contract: true, publicApi: false, barrels: false, cycles: false },
      });
      expect(r.violations.some((v) => v.kind === 'contract-layer-skip')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('defineArchContract rejects rule pointing at undefined layer', () => {
    expect(() =>
      defineArchContract({
        layers: [{ name: 'a', includes: ['**/a/**'] }],
        rules: [{ from: 'b' }],
      }),
    ).toThrow(/undefined layer "b"/);
  });
});
