import { describe, expect, test } from 'bun:test';
import {
  AdoptionCheckpointStatus,
  evaluateAdoptionCheckpoint,
  type IAdoptionCheckpoint,
} from '../index.ts';

function makeCheckpoint(generatedAt: string, diffHash = 'h1'): IAdoptionCheckpoint {
  return {
    schema: 'sharkcraft.adoption-checkpoint/v1',
    kind: 'onboard',
    generatedAt,
    command: 'shrk onboard adopt diff',
    diffHash,
    targetHashes: {},
    draftHashes: {},
  };
}

describe('r16 adoption checkpoint expiry', () => {
  test('fresh checkpoint reports up-to-date with no age warning', () => {
    const now = new Date('2026-05-14T00:00:00Z');
    const cp = makeCheckpoint('2026-05-10T00:00:00Z', 'h1');
    const ev = evaluateAdoptionCheckpoint('/tmp', cp, 'h1', { now });
    expect(ev.status).toBe(AdoptionCheckpointStatus.UpToDate);
    expect(ev.ageDays).toBe(4);
    expect(ev.ageWarning).toBe(false);
  });
  test('old (but matching) checkpoint reports stale-age', () => {
    const now = new Date('2026-05-14T00:00:00Z');
    const cp = makeCheckpoint('2026-04-01T00:00:00Z', 'h1');
    const ev = evaluateAdoptionCheckpoint('/tmp', cp, 'h1', { now });
    expect(ev.status).toBe(AdoptionCheckpointStatus.StaleAge);
    expect(ev.ageWarning).toBe(true);
    expect(ev.ageDays).toBeGreaterThan(30);
  });
  test('custom --max-age-days overrides default', () => {
    const now = new Date('2026-05-14T00:00:00Z');
    const cp = makeCheckpoint('2026-05-10T00:00:00Z', 'h1');
    const ev = evaluateAdoptionCheckpoint('/tmp', cp, 'h1', { now, maxAgeDays: 2 });
    expect(ev.status).toBe(AdoptionCheckpointStatus.StaleAge);
    expect(ev.ageWarning).toBe(true);
  });
  test('hash mismatch wins over age — reports stale-diff', () => {
    const now = new Date('2026-05-14T00:00:00Z');
    const cp = makeCheckpoint('2026-01-01T00:00:00Z', 'h1');
    const ev = evaluateAdoptionCheckpoint('/tmp', cp, 'h2', { now });
    expect(ev.status).toBe(AdoptionCheckpointStatus.StaleDiff);
  });
  test('maxAgeDays=0 disables age check', () => {
    const now = new Date('2026-05-14T00:00:00Z');
    const cp = makeCheckpoint('2026-01-01T00:00:00Z', 'h1');
    const ev = evaluateAdoptionCheckpoint('/tmp', cp, 'h1', { now, maxAgeDays: 0 });
    expect(ev.status).toBe(AdoptionCheckpointStatus.UpToDate);
  });
});
