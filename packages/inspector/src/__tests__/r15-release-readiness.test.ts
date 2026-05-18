import { describe, expect, test } from 'bun:test';
import * as nodePath from 'node:path';
import { buildReleaseReadiness, inspectSharkcraft } from '../index.ts';

const DOGFOOD_CWD = nodePath.resolve(__dirname, '../../../../examples/dogfood-target');

describe('r15 release readiness', () => {
  test('returns a structured report against the dogfood target', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const report = await buildReleaseReadiness(inspection, {});
    expect(report.schema).toBe('sharkcraft.release-readiness/v1');
    expect(report.checklist.length).toBeGreaterThan(0);
    expect(report.passed.length + report.warnings.length + report.blockers.length + report.skipped.length).toBeGreaterThan(0);
  });

  test('strict mode escalates warnings to blockers', async () => {
    const inspection = await inspectSharkcraft({ cwd: DOGFOOD_CWD });
    const lenient = await buildReleaseReadiness(inspection, { strict: false });
    const strict = await buildReleaseReadiness(inspection, { strict: true });
    expect(strict.blockers.length).toBeGreaterThanOrEqual(lenient.blockers.length);
  });
});
