import { describe, expect, test } from 'bun:test';
import {
  diagnoseAdoptionCheckpointStale,
  diagnoseMcpCacheMiss,
  diagnoseMissingNodeModules,
  diagnoseMissingSharkcraftConfig,
  diagnoseUnknownCommand,
  renderDiagnosticText,
} from '../index.ts';

describe('r16 failure diagnostics', () => {
  test('missing sharkcraft config', () => {
    const d = diagnoseMissingSharkcraftConfig('/tmp/none');
    expect(d.code).toBe('missing-sharkcraft-config');
    expect(d.nextCommand).toContain('shrk onboard');
    expect(renderDiagnosticText(d)).toContain('shrk onboard');
  });
  test('missing node_modules', () => {
    const d = diagnoseMissingNodeModules();
    expect(d.code).toBe('missing-node-modules');
    expect(d.nextCommand).toBe('bun install');
  });
  test('mcp cache miss includes briefId in extra', () => {
    const d = diagnoseMcpCacheMiss('abc123');
    expect(d.extra?.briefId).toBe('abc123');
  });
  test('adoption checkpoint stale points at record command', () => {
    const d = diagnoseAdoptionCheckpointStale('drafts changed');
    expect(d.nextCommand).toContain('record-checkpoint');
  });
  test('unknown command surfaces nearest suggestions', () => {
    const d = diagnoseUnknownCommand('shrk impct', ['shrk impact', 'shrk import']);
    expect(d.code).toBe('unknown-command');
    expect(d.likelyCause).toContain('shrk impact');
  });
});
