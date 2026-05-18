import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { evaluateSmokeAssertion } from '../index.ts';

function makeFixture(): string {
  return mkdtempSync(nodePath.join(tmpdir(), 'r17-smoke-'));
}

describe('r17 smoke content assertions', () => {
  test('stdout-contains passes when value is present', () => {
    const r = evaluateSmokeAssertion({
      assertion: { type: 'stdout-contains', value: 'READY' },
      stdout: 'Verdict: READY ✓',
      stderr: '',
      fixtureRoot: '/tmp',
    });
    expect(r.status).toBe('pass');
  });
  test('stdout-contains fails when missing and required', () => {
    const r = evaluateSmokeAssertion({
      assertion: { type: 'stdout-contains', value: 'NOPE', required: true },
      stdout: 'something else',
      stderr: '',
      fixtureRoot: '/tmp',
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('stdout did not contain');
  });
  test('stderr-not-contains pass on absence', () => {
    const r = evaluateSmokeAssertion({
      assertion: { type: 'stderr-not-contains', value: 'panic' },
      stdout: '',
      stderr: 'all fine',
      fixtureRoot: '/tmp',
    });
    expect(r.status).toBe('pass');
  });
  test('file-exists detects an existing file', () => {
    const root = makeFixture();
    mkdirSync(nodePath.join(root, 'sub'), { recursive: true });
    writeFileSync(nodePath.join(root, 'sub', 'a.json'), '{}', 'utf8');
    const r = evaluateSmokeAssertion({
      assertion: { type: 'file-exists', file: 'sub/a.json' },
      stdout: '',
      stderr: '',
      fixtureRoot: root,
    });
    expect(r.status).toBe('pass');
  });
  test('json-path-exists from stdout JSON', () => {
    const r = evaluateSmokeAssertion({
      assertion: { type: 'json-path-exists', jsonPath: 'summary.totalChanges', fromStdoutJson: true },
      stdout: '$ shrk impact\n{"summary":{"totalChanges":3}}',
      stderr: '',
      fixtureRoot: '/tmp',
    });
    expect(r.status).toBe('pass');
  });
  test('output-not-empty fails on empty', () => {
    const r = evaluateSmokeAssertion({
      assertion: { type: 'output-not-empty' },
      stdout: '',
      stderr: '',
      fixtureRoot: '/tmp',
    });
    expect(r.status).toBe('fail');
  });
  test('non-required failure becomes skipped', () => {
    const r = evaluateSmokeAssertion({
      assertion: { type: 'stdout-contains', value: 'nope', required: false },
      stdout: 'something else',
      stderr: '',
      fixtureRoot: '/tmp',
    });
    expect(r.status).toBe('skipped');
  });
});
