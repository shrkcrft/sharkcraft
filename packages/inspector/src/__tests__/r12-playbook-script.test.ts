import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  buildPlaybookPreview,
  buildPlaybookScript,
  inspectSharkcraft,
  loadPlaybooks,
  validatePlaybook,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r12 playbook script/preview/validate', () => {
  test('script renders bash with comments + human review markers', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const playbooks = await loadPlaybooks(inspection);
    const p = playbooks.find((x) => x.id === 'add-service')!;
    const r = buildPlaybookScript(p);
    expect(r.script).toContain('#!/usr/bin/env bash');
    expect(r.script).toContain('=== step apply');
    expect(r.script).toContain('HUMAN REVIEW REQUIRED');
    expect(r.steps.some((s) => s.humanReview)).toBe(true);
  });

  test('preview returns structured plan', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const playbooks = await loadPlaybooks(inspection);
    const p = playbooks.find((x) => x.id === 'add-service')!;
    const preview = buildPlaybookPreview(p);
    expect(preview.steps.length).toBeGreaterThan(0);
    expect(preview.steps.some((s) => s.humanReview)).toBe(true);
  });

  test('validate flags missing pipeline reference', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const playbooks = await loadPlaybooks(inspection);
    const p = playbooks.find((x) => x.id === 'add-service')!;
    const v = validatePlaybook(p, inspection);
    expect(v.issues.some((i) => i.code === 'missing-pipeline')).toBe(true);
  });
});
