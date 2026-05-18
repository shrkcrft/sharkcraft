import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildAgentHandoff,
  buildRepositoryMemory,
  inspectSharkcraft,
  saveRepositoryMemory,
} from '../index.ts';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r24-handoff-'));
  try {
    writeFileSync(
      nodePath.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    );
    // a tiny history so memory has something
    const sessions = nodePath.join(root, '.sharkcraft', 'sessions', 's1');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      nodePath.join(sessions, 'session.json'),
      JSON.stringify({ intent: { kind: 'feature' }, affectedConstructs: [{ id: 'plugin-api' }] }),
    );
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('unified handoff', () => {
  it('include-contract injects a contract summary', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await buildAgentHandoff(inspection, {
        task: 'change plugin-api public API',
        includeContract: true,
      });
      expect(r.contract).toBeDefined();
      expect(r.contractSummary).toBeDefined();
      expect(r.markdown).toContain('## Agent contract');
    });
  });

  it('include-memory injects memory warnings when index exists', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const idx = await buildRepositoryMemory(inspection);
      saveRepositoryMemory(root, idx);
      const r = await buildAgentHandoff(inspection, {
        task: 'change plugin-api public API',
        includeMemory: true,
      });
      expect(r.memoryRisk).toBeDefined();
      expect(r.markdown).toContain('## Memory-driven warnings');
    });
  });

  it('include-plan-simulation injects plan readiness when plan exists', async () => {
    await withRoot(async (root) => {
      const planFile = nodePath.join(root, 'plan.json');
      writeFileSync(
        planFile,
        JSON.stringify({
          schema: 'sharkcraft.plan/v1',
          templateId: 'noop',
          variables: {},
          projectRoot: root,
          createdAt: new Date().toISOString(),
          expectedChanges: [{ type: 'create', relativePath: 'src/foo.ts', sizeBytes: 12 }],
        }),
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await buildAgentHandoff(inspection, {
        task: 'add foo',
        includePlanSimulation: planFile,
      });
      expect(r.planSimulation).toBeDefined();
      expect(r.markdown).toContain('## Plan simulation');
    });
  });

  it('JSON shape is stable — every field is optional', async () => {
    await withRoot(async (root) => {
      const inspection = await inspectSharkcraft({ cwd: root });
      const r = await buildAgentHandoff(inspection, { task: 'docs cleanup' });
      // No flag passed; the optional fields should be undefined.
      expect(r.contract).toBeUndefined();
      expect(r.memoryRisk).toBeUndefined();
      expect(r.planSimulation).toBeUndefined();
      expect(r.executionGraph).toBeUndefined();
    });
  });
});
