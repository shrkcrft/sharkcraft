import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  PLAN_SIMULATION_SCHEMA,
  PlanApplyReadiness,
  PlanSimulationOperationOutcome,
  inspectSharkcraft,
  simulatePlan,
} from '../index.ts';

function setupRoot(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r23-plansim-'));
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  mkdirSync(nodePath.join(root, '.sharkcraft'), { recursive: true });
  return root;
}

function writePlan(root: string, plan: unknown): string {
  const file = nodePath.join(root, 'plan.json');
  writeFileSync(file, JSON.stringify(plan), 'utf8');
  return file;
}

describe('plan simulation v2', () => {
  it('v1 create-only plan reports ready and creates-new outcome', async () => {
    const root = setupRoot();
    try {
      const planFile = writePlan(root, {
        schema: 'sharkcraft.plan/v1',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [
          { type: 'create', relativePath: 'src/foo.ts', sizeBytes: 12 },
        ],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, planFile);
      expect(r.schema).toBe(PLAN_SIMULATION_SCHEMA);
      expect(r.files[0]!.outcome).toBe(PlanSimulationOperationOutcome.CreatesNew);
      expect(r.applyReadiness).toBe(PlanApplyReadiness.Ready);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('v2 plan with create+append surfaces modifies-existing', async () => {
    const root = setupRoot();
    try {
      const planFile = writePlan(root, {
        schema: 'sharkcraft.plan/v2',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [
          { type: 'create', relativePath: 'src/a.ts', sizeBytes: 10 },
          { type: 'append', relativePath: 'src/index.ts', sizeBytes: 5 },
        ],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, planFile);
      const types = r.files.map((f) => f.outcome);
      expect(types).toContain(PlanSimulationOperationOutcome.CreatesNew);
      expect(types).toContain(PlanSimulationOperationOutcome.ModifiesExisting);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('plan with conflict outcome is blocked', async () => {
    const root = setupRoot();
    try {
      const planFile = writePlan(root, {
        schema: 'sharkcraft.plan/v2',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [
          { type: 'conflict', relativePath: 'src/x.ts', sizeBytes: 1 },
        ],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, planFile);
      expect(r.applyReadiness).toBe(PlanApplyReadiness.BlockedConflicts);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('public-api touch is flagged on plan files at /index.ts', async () => {
    const root = setupRoot();
    try {
      const planFile = writePlan(root, {
        schema: 'sharkcraft.plan/v2',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [
          { type: 'append', relativePath: 'src/index.ts', sizeBytes: 5 },
        ],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, planFile);
      expect(r.publicApiTouched).toBe(true);
      expect(r.barrelExportTouched).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('likely tests are computed for src/* TS files', async () => {
    const root = setupRoot();
    try {
      const planFile = writePlan(root, {
        schema: 'sharkcraft.plan/v1',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [
          { type: 'create', relativePath: 'src/services/user.service.ts', sizeBytes: 12 },
        ],
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, planFile);
      expect(r.likelyTests.join(' ')).toContain('user.service.spec.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('signature status is reflected when present', async () => {
    const root = setupRoot();
    try {
      const planFile = writePlan(root, {
        schema: 'sharkcraft.plan/v1',
        templateId: 'noop',
        variables: {},
        projectRoot: root,
        createdAt: new Date().toISOString(),
        expectedChanges: [],
        signature: { algo: 'sha256', hmac: 'deadbeef', signedAt: new Date().toISOString() },
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await simulatePlan(inspection, planFile);
      // No secret set in test → invalid; either 'invalid' or 'present' depending on env.
      expect(r.signature).not.toBe('absent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
