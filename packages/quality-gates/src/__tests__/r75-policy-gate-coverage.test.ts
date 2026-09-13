/**
 * Round 11 — the quality-gates POLICY gate (`shrk gate`, the MCP quality-gate
 * tool, the dashboard) carries the policy engine's per-rule coverage on every
 * result, so `shrk gate` settles its exit on the same records `policy-lint`
 * does. Before, the pass branch and the "nothing evaluated" branch decided on
 * their own: `[pass] Policy lint` (exit 0) over a rule that scanned nothing,
 * where `policy-lint` / `quality` exit 2.
 *
 * Real workspace, real config loader, real engine.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageShortfall, type IPolicyRule } from '@shrkcrft/core';
import { runPolicyLint } from '@shrkcrft/boundaries';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import { policyLintGate } from '../gates/policy-lint-gate.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const LIVE = "{ id: 'live', surface: 'ts', files: ['src/**/*.ts'], pattern: 'ZZZNEVER', message: 'm', severity: 'warning' }";
const STALE_WARN =
  "{ id: 'stale', surface: 'ts', files: ['nowhere/**/*.ts'], pattern: 'XQZ', message: 'x', severity: 'warning', failOnEmpty: false }";
const STALE_ERR = "{ id: 'stale-err', surface: 'ts', files: ['nowhere/**/*.ts'], pattern: 'XQZ', message: 'x', severity: 'error' }";

function workspace(rules: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-qg-policy-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', policyRules: [ ${rules.join(', ')} ] };\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

async function rulesOf(root: string): Promise<readonly IPolicyRule[]> {
  const loaded = await resolveProjectConfig(root);
  if (!loaded.ok) throw new Error(`fixture config failed to load: ${loaded.error.message}`);
  return loaded.value.config.policyRules ?? [];
}

describe('quality-gates policy gate — a rule that scanned nothing is never `pass` or `skipped`', () => {
  test('a live rule next to a stale warning rule: warn, NOT VERIFIED naming the stale rule, coverage on the result', async () => {
    const root = workspace([LIVE, STALE_WARN]);
    const r = policyLintGate(root, { rules: await rulesOf(root) });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('NOT VERIFIED');
    expect(r.message).toContain('stale: ');
    const shortfalls = (r.details as { shortfalls?: string[] } | undefined)?.shortfalls ?? [];
    expect(shortfalls.length).toBe(1);
    expect(shortfalls[0]).toStartWith('stale: ');
    const bySubject = new Map((r.coverage ?? []).map((c) => [c.subject, c]));
    expect(coverageShortfall(bySubject.get('live')!)).toBeUndefined();
    expect(coverageShortfall(bySubject.get('stale')!)).toContain('0 content units to examine');
  });

  test('ONLY a stale warning rule: warn — "nothing evaluated" is not a skip', async () => {
    const root = workspace([STALE_WARN]);
    const r = policyLintGate(root, { rules: await rulesOf(root) });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('nothing evaluated');
    expect(r.message).toContain('NOT VERIFIED');
    expect(r.coverage?.[0]).toMatchObject({ subject: 'stale', expected: 0, examined: 0 });
  });

  test('a stale ERROR rule (failOnEmpty by default) next to a live rule: fail, naming it', async () => {
    const root = workspace([LIVE, STALE_ERR]);
    const r = policyLintGate(root, { rules: await rulesOf(root) });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('failOnEmpty: stale-err');
    expect((r.details as { failedOnEmpty?: string[] }).failedOnEmpty).toEqual(['stale-err']);
  });

  test('a fully examined clean run is a pass, and every record examined its scope', async () => {
    const root = workspace([LIVE]);
    const r = policyLintGate(root, { rules: await rulesOf(root) });
    expect(r.status).toBe('pass');
    expect((r.coverage ?? []).map((c) => coverageShortfall(c))).toEqual([undefined]);
  });

  test("the gate reads the ENGINE's record — never a second derivation", async () => {
    const root = workspace([LIVE, STALE_WARN]);
    const rules = await rulesOf(root);
    const engine = runPolicyLint(root, rules).rules.map((x) => ({ ...x.coverage, subject: x.ruleId }));
    expect(policyLintGate(root, { rules }).coverage).toEqual(engine);
  });

  test('--changed-only that puts no rule in scope (a pure deletion) is narrowing: skipped', async () => {
    const root = workspace([LIVE, STALE_ERR]);
    const r = policyLintGate(root, { rules: await rulesOf(root), changedOnly: true, changedFiles: ['src/gone.ts'] });
    expect(r.status).toBe('skipped');
    expect(r.coverage).toBeUndefined();
  });
});
