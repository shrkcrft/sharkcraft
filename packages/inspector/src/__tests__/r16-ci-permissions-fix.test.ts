import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { auditCiWorkflow, buildCiPermissionsFixPreview, renderCiPermissionsFixPreview } from '../index.ts';

function makeFixture(name: string, body: string): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'r16-ci-fix-'));
  const file = nodePath.join(root, '.github', 'workflows', name);
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('r16 ci permissions fix preview', () => {
  test('comment-posting without write perms suggests add-pull-requests-write', () => {
    const file = makeFixture(
      'review.yml',
      `name: SharkCraft Review\non: [pull_request]\njobs:\n  review:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: gh pr comment $PR --body "ok"\n        env:\n          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n`,
    );
    const audit = auditCiWorkflow({ file, provider: 'github-actions' });
    const preview = buildCiPermissionsFixPreview(audit);
    const codes = preview.hints.map((h) => h.code);
    expect(codes).toContain('add-pull-requests-write');
  });
  test('write perms without comment posting suggests narrow', () => {
    const file = makeFixture(
      'broad.yml',
      `name: SharkCraft Quality\non: [pull_request]\npermissions:\n  contents: write\njobs:\n  q:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo ok\n`,
    );
    const audit = auditCiWorkflow({ file, provider: 'github-actions' });
    const preview = buildCiPermissionsFixPreview(audit);
    const codes = preview.hints.map((h) => h.code);
    expect(codes).toContain('remove-pull-requests-write');
  });
  test('markdown render returns non-empty content', () => {
    const file = makeFixture(
      'mini.yml',
      `name: M\non: [pull_request]\njobs:\n  q:\n    runs-on: ubuntu-latest\n    steps: []\n`,
    );
    const audit = auditCiWorkflow({ file, provider: 'github-actions' });
    const preview = buildCiPermissionsFixPreview(audit);
    const md = renderCiPermissionsFixPreview(preview, 'markdown');
    expect(md).toContain('CI permissions fix preview');
    const json = renderCiPermissionsFixPreview(preview, 'json');
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('sharkcraft.ci-permissions-fix/v1');
  });
});
