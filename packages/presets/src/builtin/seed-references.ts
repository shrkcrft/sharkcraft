// References a seeded preset entry declares (round 15 follow-up, F5/F13).
//
// A seeded entry with no references is unverifiable, so a fresh
// `shrk init --preset <id>` failed its own `shrk knowledge stale-check` (exit 2)
// and `shrk quality`. Each entry now declares a reference that is TRUE on a
// fresh repo of its preset's kind — the framework's marker file (angular.json,
// nest-cli.json, nx.json, turbo.json, pom.xml, go.mod, Cargo.toml) where every
// repo of that kind has one; else `package.json` (every JS/TS kind); else a
// file `shrk init` itself creates (the sharkcraft/ config, paths, pipelines).
// Python (pyproject.toml OR requirements.txt) and Gradle (build.gradle OR
// build.gradle.kts) have no single marker every fresh repo carries, so their
// path seeds point at the declaring sharkcraft/paths.ts, like the shared path
// seeds. A marker reference also carries meaning: when the repo stops being of
// that kind, the entry goes stale.
//
// Locked per preset by packages/cli/src/__tests__/r78-seed-references-verify.test.ts.

import type { IAssetReference } from '@shrkcrft/core';

function literal(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Render references as the TypeScript an emitted `sharkcraft/*.ts` snippet
 * embeds (`references: [{ kind: 'file', path: 'angular.json', note: '…' }],`).
 */
export function renderSeedReferences(refs: readonly IAssetReference[]): string {
  const items = refs.map((ref) => {
    const fields = Object.entries(ref)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? literal(v) : JSON.stringify(v)}`);
    return `{ ${fields.join(', ')} }`;
  });
  return `references: [${items.join(', ')}],`;
}

/** Every JS / TS kind: the package the rule governs. */
export const SEED_REF_PACKAGE_JSON: IAssetReference = {
  kind: 'file',
  path: 'package.json',
  note: 'the package this entry governs',
};

export const SEED_REF_ANGULAR_JSON: IAssetReference = {
  kind: 'file',
  path: 'angular.json',
  note: 'the Angular workspace this entry governs',
};

export const SEED_REF_NEST_CLI_JSON: IAssetReference = {
  kind: 'file',
  path: 'nest-cli.json',
  note: 'the Nest project this entry governs',
};

export const SEED_REF_NX_JSON: IAssetReference = {
  kind: 'file',
  path: 'nx.json',
  note: 'the Nx workspace this entry governs',
};

export const SEED_REF_TURBO_JSON: IAssetReference = {
  kind: 'file',
  path: 'turbo.json',
  note: 'the Turborepo task graph this entry governs',
};

export const SEED_REF_SHARKCRAFT_CONFIG: IAssetReference = {
  kind: 'file',
  path: 'sharkcraft/sharkcraft.config.ts',
  note: 'the config that wires SharkCraft into this repo',
};

export const SEED_REF_SHARKCRAFT_PIPELINES: IAssetReference = {
  kind: 'file',
  path: 'sharkcraft/pipelines.ts',
  note: 'the pipelines list_pipelines and shrk task serve',
};

export const SEED_REF_TESTS_PATH_CONVENTION: IAssetReference = {
  kind: 'path-convention',
  id: 'paths.tests',
  note: 'the tests path convention this rule targets',
};

/**
 * A path seed's reference: the kind's marker file (or the declaring
 * sharkcraft/paths.ts where the kind has none), with a note teaching the
 * `directory:` form to switch to once the directory exists.
 */
export function seedPathReference(markerPath: string, dir: string): IAssetReference {
  return {
    kind: 'file',
    path: markerPath,
    note: `seed: once ${dir} exists, point at it — { kind: 'directory', path: '${dir}' }`,
  };
}
