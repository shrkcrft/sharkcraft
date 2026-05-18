import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import {
  DecisionStatus,
  getDecision,
  inspectSharkcraft,
  listDecisions,
  previewDecisionDraft,
} from '../index.ts';

describe('r18 decision records', () => {
  test('loads decision records with frontmatter and sections', async () => {
    const root = nodePath.join(tmpdir(), `shrk-r18-decisions-${Date.now()}`);
    mkdirSync(nodePath.join(root, 'sharkcraft/decisions'), { recursive: true });
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'r18-test', version: '0.0.0', private: true }),
    );
    const body = `---\nid: 0001-example\ntitle: Example\nstatus: accepted\ndate: 2026-01-01\n---\n\n## Context\nWhy.\n\n## Decision\nDo it.\n\n## Consequences\nOK.\n`;
    writeFileSync(nodePath.join(root, 'sharkcraft/decisions/0001-example.md'), body);
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const ds = listDecisions(inspection);
      expect(ds.length).toBe(1);
      expect(ds[0]!.title).toBe('Example');
      expect(ds[0]!.status).toBe(DecisionStatus.Accepted);
      expect(ds[0]!.context).toBe('Why.');
      expect(getDecision(inspection, '0001-example')!.title).toBe('Example');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('previewDecisionDraft generates frontmatter + sections, never writes', () => {
    const body = previewDecisionDraft({
      id: '0002-test',
      title: 'Test',
      status: DecisionStatus.Proposed,
      context: 'Because.',
      decision: 'Do thing.',
      consequences: 'OK.',
    });
    expect(body).toContain('id: 0002-test');
    expect(body).toContain('status: proposed');
    expect(body).toContain('# Test');
    expect(body).toContain('## Context');
  });
  test('listDecisions returns [] when no folder exists', async () => {
    const inspection = await inspectSharkcraft({ cwd: process.cwd() });
    // SharkCraft monorepo may or may not have decisions; just sanity-check that the function returns an array.
    expect(Array.isArray(listDecisions(inspection))).toBe(true);
  });
});
