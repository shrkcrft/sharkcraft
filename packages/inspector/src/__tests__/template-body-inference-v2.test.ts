import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inferTemplateBodyV2 } from '../template-body-inference-v2.ts';

function makeSample(name: string, body: string): { root: string; sample: string } {
  const root = mkdtempSync(join(tmpdir(), 'shrk-tb-v2-'));
  mkdirSync(join(root, 'src/services'), { recursive: true });
  const rel = `src/services/${name}`;
  writeFileSync(join(root, rel), body);
  return { root, sample: rel };
}

describe('template-body inference v2', () => {
  test('detects exported class via AST', async () => {
    const { root, sample } = makeSample(
      'user.service.ts',
      [
        'export class UserService {',
        '  constructor(private readonly id: string) {}',
        '  public greet(): string { return "hello"; }',
        '}',
        '',
      ].join('\n'),
    );
    const r = await inferTemplateBodyV2({ projectRoot: root, sample, kind: 'service' });
    expect(r.provenance === 'ast' || r.provenance === 'lightweight').toBe(true);
    expect(r.scaffold?.confidence === 'high' || r.scaffold?.confidence === 'medium').toBe(true);
    expect(r.scaffold?.variables.find((v) => v.name === 'className')?.default).toBe('UserService');
  });

  test('detects exported function', async () => {
    const { root, sample } = makeSample(
      'format-email.util.ts',
      'export function formatEmail(addr: string): string { return addr.trim(); }\n',
    );
    const r = await inferTemplateBodyV2({ projectRoot: root, sample, kind: 'utility' });
    expect(r.provenance === 'ast' || r.provenance === 'lightweight').toBe(true);
    expect(r.scaffold?.variables.find((v) => v.name === 'fnName')).toBeDefined();
  });

  test('skips files with too many string literals', async () => {
    const big = Array.from({ length: 20 }, (_, i) => `const m${i} = "literal-${i}";`).join('\n');
    const { root, sample } = makeSample('domain.service.ts', big);
    const r = await inferTemplateBodyV2({ projectRoot: root, sample, kind: 'service' });
    expect(r.provenance).toBe('skipped');
    expect(r.reason).toContain('string literals');
  });

  test('skips files with side-effectful top-level code', async () => {
    const { root, sample } = makeSample(
      'runner.service.ts',
      'runEverythingAtStartup();\nexport class X {}\n',
    );
    const r = await inferTemplateBodyV2({ projectRoot: root, sample, kind: 'service' });
    expect(r.provenance).toBe('skipped');
  });
});
