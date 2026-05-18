/**
 * safety audit --deep schema v2: infoOnlyFindings field.
 *
 * Schema bumped to v2 so the human render can be honest about the
 * dev-signed packs disposition without breaking the existing JSON
 * contract for blocker findings.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {
  buildSafetyAuditDeep,
  SAFETY_AUDIT_DEEP_SCHEMA,
  inspectSharkcraft,
} from '../index.ts';

describe('safety-audit-deep schema v2', () => {
  test('schema string bumped to v2', () => {
    expect(SAFETY_AUDIT_DEEP_SCHEMA).toBe('sharkcraft.safety-audit-deep/v2');
  });

  test('report carries infoOnlyFindings when no dev packs', async () => {
    const root = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r55-deep-'));
    try {
      const inspection = await inspectSharkcraft({ cwd: root });
      const report = await buildSafetyAuditDeep(inspection);
      expect(report.schema).toBe('sharkcraft.safety-audit-deep/v2');
      expect(typeof report.infoOnlyFindings).toBe('number');
      // Empty workspace → no dev-signed packs → infoOnlyFindings = 0.
      expect(report.infoOnlyFindings).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
