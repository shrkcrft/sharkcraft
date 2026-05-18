import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import {
  buildRunbook,
  inspectSharkcraft,
  loadConstructs,
  loadPlaybooks,
  recommendPlaybooks,
  traceConstruct,
} from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r11 constructs', () => {
  test('loadConstructs returns local definitions', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const list = await loadConstructs(inspection);
    const userService = list.find((c) => c.id === 'user-service');
    expect(userService).toBeDefined();
    expect(userService?.type).toBe('service');
  });

  test('traceConstruct surfaces files/publicApi/events', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const list = await loadConstructs(inspection);
    const httpServer = list.find((c) => c.id === 'http-server')!;
    const trace = traceConstruct(httpServer);
    expect(trace.events).toContain('server.start');
    expect(trace.files).toContain('src/server.ts');
  });
});

describe('r11 playbooks', () => {
  test('loadPlaybooks returns add-service', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const list = await loadPlaybooks(inspection);
    const addService = list.find((p) => p.id === 'add-service');
    expect(addService).toBeDefined();
    expect(addService?.steps.length).toBeGreaterThan(0);
  });

  test('recommendPlaybooks scores matching tasks', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const playbooks = await loadPlaybooks(inspection);
    const recs = recommendPlaybooks(playbooks, 'generate a user profile service');
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]!.playbook.id).toBe('add-service');
  });

  test('buildRunbook returns numbered steps', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const playbooks = await loadPlaybooks(inspection);
    const rb = buildRunbook(playbooks[0]!);
    expect(rb.steps.length).toBeGreaterThan(0);
    expect(rb.steps[0]!.id).toBeDefined();
  });
});
