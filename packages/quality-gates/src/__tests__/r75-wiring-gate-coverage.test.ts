/**
 * Round 11 stage 0 — the quality-gates wiring gate (`shrk gate`, the MCP
 * `get_quality_gate` tool, the dashboard) no longer decides "pass" from the
 * engine's `verdict` alone. A rule that passed over part of its scope — a
 * subset rule whose declared selector never produced a registered token — is
 * `warn`, naming the shortfall, exactly where `check wiring` reads not-verified.
 *
 * Real workspace, real config loader.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import { wiringGate } from '../gates/wiring-gate.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(extra: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-qg-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'src/h/a.ts': 'export const A_H = 1;\n',
    'src/h/b.ts': 'export const B_H = 2;\n',
    'src/reg.ts': 'export const H = [A_H, B_H, C_H];\n',
    'sharkcraft/sharkcraft.config.ts':
      "export default { projectName: 'fx', wiringRules: [{ id: 'subset-rule', " +
      "declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, " +
      `registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' }${extra} }] };\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

async function gateFor(root: string): Promise<ReturnType<typeof wiringGate>> {
  const loaded = await resolveProjectConfig(root);
  if (!loaded.ok) throw new Error(`fixture config failed to load: ${loaded.error.message}`);
  return wiringGate(root, { rules: loaded.value.config.wiringRules ?? [] });
}

describe('quality-gates wiring gate — a partial rule is never `pass`', () => {
  test('declared 2 / registered 3: warn, naming the rule and the unexamined token', async () => {
    const r = await gateFor(workspace(''));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('NOT VERIFIED');
    expect(r.message).toContain('C_H');
    const shortfalls = (r.details as { shortfalls?: string[] } | undefined)?.shortfalls ?? [];
    expect(shortfalls.length).toBe(1);
    expect(shortfalls[0]).toStartWith('subset-rule: ');
  });

  test('registeredExtras accepts the known extra explicitly: pass', async () => {
    const r = await gateFor(workspace(", registeredExtras: ['C_H']"));
    expect(r.status).toBe('pass');
  });
});

/**
 * One wiring rule whose DECLARED glob matches nothing (a stale selector) while
 * its registered side exists. `check wiring` reads 2 (warning) / 1 (error,
 * failOnEmpty by default); the gate used to report `skipped` with no coverage,
 * which `shrk gate` settled to 0.
 */
function staleRuleWorkspace(severity: 'warning' | 'error'): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-qg-stale-'));
  roots.push(root);
  const flags = severity === 'warning' ? "severity: 'warning', failOnEmpty: false, " : '';
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'src/reg.ts': 'export const H = [];\n',
    'sharkcraft/sharkcraft.config.ts':
      `export default { projectName: 'fx', wiringRules: [{ id: 'w-stale', ${flags}` +
      "declared: { files: ['nowhere/*.ts'], extract: 'export-names' }, " +
      "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('quality-gates wiring gate — a SELECTED rule that examined nothing is never `skipped`', () => {
  test('warning rule, declared glob matches nothing: warn + the rule coverage (NOT VERIFIED), never skipped', async () => {
    const r = await gateFor(staleRuleWorkspace('warning'));
    expect(r.status).toBe('warn');
    expect(r.message).toContain('NOT VERIFIED');
    expect(r.message).toContain('nothing evaluated');
    expect(r.coverage?.[0]).toMatchObject({ subject: 'w-stale', expected: 0, examined: 0 });
  });

  test('error rule (failOnEmpty by default): fail, exactly where `check wiring` exits 1', async () => {
    const r = await gateFor(staleRuleWorkspace('error'));
    expect(r.status).toBe('fail');
    expect((r.details as { failedOnEmpty?: string[] }).failedOnEmpty).toEqual(['w-stale']);
    expect(r.coverage?.length).toBe(1);
  });

  test('--changed-only that selects no rule is narrowing: skipped, no coverage', async () => {
    const root = staleRuleWorkspace('error');
    const loaded = await resolveProjectConfig(root);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const r = wiringGate(root, {
      rules: loaded.value.config.wiringRules ?? [],
      changedOnly: true,
      changedFiles: ['README.md'],
    });
    expect(r.status).toBe('skipped');
    expect(r.coverage).toBeUndefined();
  });
});
