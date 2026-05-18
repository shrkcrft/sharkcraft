/**
 * SharkCraft upgrade advisor.
 *
 * Read-only advisor that detects schema versions across the repo and
 * suggests safe manual upgrade steps. Never auto-migrates.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const UPGRADE_ADVISOR_SCHEMA = 'sharkcraft.upgrade-advisor/v1';

export interface IUpgradeFinding {
  id: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestedAction: string;
}

export interface IUpgradeAdviceReport {
  schema: typeof UPGRADE_ADVISOR_SCHEMA;
  generatedAt: string;
  fromVersion: string;
  toVersion: string;
  detectedSchemas: Record<string, string>;
  findings: readonly IUpgradeFinding[];
  recommendedSteps: readonly string[];
}

function detectSchemaVersion(text: string): string | null {
  const m = /"schema"\s*:\s*"([^"]+)"/.exec(text);
  return m ? (m[1] ?? null) : null;
}

function scanFile(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8');
    return detectSchemaVersion(t);
  } catch {
    return null;
  }
}

function walkSchemas(dir: string, max: number): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: string[] = [dir];
  let count = 0;
  while (stack.length && count < max) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const f of entries) {
      const full = nodePath.join(cur, f);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) stack.push(full);
        else if (f.endsWith('.json')) {
          const v = scanFile(full);
          if (v) out[v] = (out[v] ?? '') + (full + '\n');
          count++;
        }
      } catch {
        continue;
      }
    }
  }
  // Return only the *schema names → first file* pairing.
  const compact: Record<string, string> = {};
  for (const [k, v] of Object.entries(out)) compact[k] = v.split('\n')[0] ?? '';
  return compact;
}

export function buildUpgradeAdvice(
  inspection: ISharkcraftInspection,
  options: { from?: string; to?: string } = {},
): IUpgradeAdviceReport {
  const findings: IUpgradeFinding[] = [];

  const detected = walkSchemas(nodePath.join(inspection.projectRoot, '.sharkcraft'), 600);

  const fromVersion = options.from ?? '0.1.0-alpha.2';
  const toVersion = options.to ?? 'current';

  // Heuristics: surface known evolving schemas.
  if (detected['sharkcraft.repository-map/v1']) {
    findings.push({
      id: 'repository-map-v1-present',
      severity: 'info',
      message: 'sharkcraft.repository-map/v1 artefacts found. sharkcraft.repository-intelligence/v1 ships alongside it.',
      suggestedAction: 'No action required; run `shrk intelligence graph` for the new surface.',
    });
  }

  if (detected['sharkcraft.feature-bundle/v1']) {
    findings.push({
      id: 'feature-bundle-v1',
      severity: 'info',
      message: 'Feature bundle v1 schema detected.',
      suggestedAction: 'No migration needed — schema is stable across 0.1.x.',
    });
  }

  // Adoption checkpoints can become stale across SharkCraft versions.
  const checkpointDir = nodePath.join(inspection.projectRoot, '.sharkcraft', 'adoption-checkpoints');
  if (existsSync(checkpointDir)) {
    findings.push({
      id: 'adoption-checkpoint-rehash',
      severity: 'info',
      message: 'Adoption checkpoints found. Upgrading SharkCraft may rewrite diff formatting.',
      suggestedAction: 'After upgrade, re-run adoption with `--record-checkpoint` if hashes diverge.',
    });
  }

  const recommendedSteps: string[] = [
    'shrk doctor',
    'shrk commands doctor',
    'shrk safety audit',
    'shrk release readiness',
    'bun x tsc -p tsconfig.base.json --noEmit',
    'bun test',
  ];

  return {
    schema: UPGRADE_ADVISOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    fromVersion,
    toVersion,
    detectedSchemas: detected,
    findings,
    recommendedSteps,
  };
}
