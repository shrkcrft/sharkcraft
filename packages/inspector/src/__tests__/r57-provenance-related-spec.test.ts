/**
 * Provenance `relatedSpec` field bumps the schema to v2 iff
 * populated. v1 entries stay readable forever.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  AssetKind,
  AssetProvenanceOperation,
  AssetProvenanceSource,
  ASSET_PROVENANCE_SCHEMA,
  ASSET_PROVENANCE_SCHEMA_V2,
  provenancePath,
  readProvenance,
  recordProvenance,
} from '../asset-provenance.ts';

let projectRoot: string;

beforeEach(() => {
  projectRoot = nodePath.join(
    '/tmp',
    `r57-prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(nodePath.join(projectRoot, '.sharkcraft'), { recursive: true });
});

afterEach(() => {
  if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
});

describe('asset-provenance: relatedSpec back-pointer', () => {
  test('entries WITHOUT relatedSpec stay schema v1', () => {
    recordProvenance({
      projectRoot,
      entry: {
        operation: AssetProvenanceOperation.Add,
        assetKind: AssetKind.Knowledge,
        assetId: 'demo',
        source: AssetProvenanceSource.Cli,
      },
    });
    const lines = readFileSync(provenancePath(projectRoot), 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schema).toBe(ASSET_PROVENANCE_SCHEMA);
    expect(parsed.relatedSpec).toBeUndefined();
  });

  test('entries WITH relatedSpec bump to schema v2', () => {
    recordProvenance({
      projectRoot,
      entry: {
        operation: AssetProvenanceOperation.Apply,
        assetKind: 'spec',
        assetId: '2026-05-17-demo',
        source: AssetProvenanceSource.Cli,
        relatedSpec: '2026-05-17-demo',
      },
    });
    const lines = readFileSync(provenancePath(projectRoot), 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schema).toBe(ASSET_PROVENANCE_SCHEMA_V2);
    expect(parsed.relatedSpec).toBe('2026-05-17-demo');
  });

  test('readProvenance accepts both v1 and v2 entries', () => {
    recordProvenance({
      projectRoot,
      entry: {
        operation: AssetProvenanceOperation.Add,
        assetKind: AssetKind.Knowledge,
        assetId: 'a',
        source: AssetProvenanceSource.Cli,
      },
    });
    recordProvenance({
      projectRoot,
      entry: {
        operation: AssetProvenanceOperation.Apply,
        assetKind: 'spec',
        assetId: 'b',
        source: AssetProvenanceSource.Cli,
        relatedSpec: '2026-05-17-demo',
      },
    });
    const entries = readProvenance(projectRoot);
    expect(entries.length).toBe(2);
    expect(entries[0]!.schema).toBe(ASSET_PROVENANCE_SCHEMA);
    expect(entries[1]!.schema).toBe(ASSET_PROVENANCE_SCHEMA_V2);
  });
});
