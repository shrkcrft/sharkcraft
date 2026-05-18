import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IDiscoveredPack } from '@shrkcrft/packs';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PACK_COMPATIBILITY_SCHEMA = 'sharkcraft.pack-compatibility/v1';

export interface IPackCompatibilityHit {
  status: 'compatible' | 'incompatible' | 'warning';
  reason: string;
}

export interface IPackCompatibility {
  schema: typeof PACK_COMPATIBILITY_SCHEMA;
  packageName: string;
  packageVersion: string;
  overall: 'compatible' | 'incompatible' | 'warning';
  sharkcraftVersion: string;
  runtime: string;
  packageManager: string;
  workspaceProfiles: readonly string[];
  hits: readonly IPackCompatibilityHit[];
}

interface IPackCompatibilityField {
  sharkcraft?: string;
  runtimes?: readonly string[];
  frameworks?: readonly string[];
  packageManagers?: readonly string[];
}

function detectRuntime(): string {
  if (typeof Bun !== 'undefined') return 'bun';
  return 'node';
}

function detectPackageManager(projectRoot: string): string {
  if (existsSync(nodePath.join(projectRoot, 'bun.lock')) || existsSync(nodePath.join(projectRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(nodePath.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(nodePath.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(nodePath.join(projectRoot, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

function readSharkcraftVersion(): string {
  try {
    const pkg = nodePath.join(import.meta.dir ?? __dirname, '..', 'package.json');
    if (existsSync(pkg)) {
      const v = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string };
      if (v.version) return v.version;
    }
  } catch {
    /* ignore */
  }
  return '0.1.0';
}

function semverInRange(v: string, range: string): boolean {
  // Very small semver subset: '^X.Y.Z', '~X.Y.Z', or 'X.Y.Z'.
  const m = /^(\^|~)?(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!m) return true;
  const op = m[1];
  const major = Number(m[2]);
  const minor = Number(m[3]);
  const patch = Number(m[4]);
  const cm = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!cm) return false;
  const cMajor = Number(cm[1]);
  const cMinor = Number(cm[2]);
  const cPatch = Number(cm[3]);
  if (op === '^') {
    if (major === 0) {
      return cMajor === 0 && cMinor === minor && cPatch >= patch;
    }
    if (cMajor !== major) return false;
    return cMinor > minor || (cMinor === minor && cPatch >= patch);
  }
  if (op === '~') {
    return cMajor === major && cMinor === minor && cPatch >= patch;
  }
  return cMajor === major && cMinor === minor && cPatch === patch;
}

export function checkPackCompatibility(
  inspection: ISharkcraftInspection,
  pack: IDiscoveredPack,
): IPackCompatibility {
  const manifest = pack.manifest as
    | ({ compatibility?: IPackCompatibilityField } & Record<string, unknown>)
    | undefined;
  const compat = manifest?.compatibility ?? {};
  const sharkcraftVersion = readSharkcraftVersion();
  const runtime = detectRuntime();
  const pm = detectPackageManager(inspection.projectRoot);
  const profiles = inspection.workspace.profiles ?? [];

  const hits: IPackCompatibilityHit[] = [];

  if (compat.sharkcraft && !semverInRange(sharkcraftVersion, compat.sharkcraft)) {
    hits.push({ status: 'incompatible', reason: `Pack requires SharkCraft ${compat.sharkcraft} — current ${sharkcraftVersion}` });
  } else if (compat.sharkcraft) {
    hits.push({ status: 'compatible', reason: `SharkCraft ${compat.sharkcraft} satisfied by ${sharkcraftVersion}` });
  }

  if (compat.runtimes && compat.runtimes.length > 0) {
    if (compat.runtimes.includes(runtime)) hits.push({ status: 'compatible', reason: `Runtime ${runtime} supported` });
    else hits.push({ status: 'incompatible', reason: `Runtime ${runtime} not in ${compat.runtimes.join(', ')}` });
  }

  if (compat.packageManagers && compat.packageManagers.length > 0) {
    if (compat.packageManagers.includes(pm)) hits.push({ status: 'compatible', reason: `Package manager ${pm} supported` });
    else hits.push({ status: 'warning', reason: `Package manager ${pm} not listed in ${compat.packageManagers.join(', ')}` });
  }

  if (compat.frameworks && compat.frameworks.length > 0) {
    const overlap = profiles.filter((p) => compat.frameworks!.includes(p));
    if (overlap.length > 0) hits.push({ status: 'compatible', reason: `Frameworks match: ${overlap.join(', ')}` });
    else hits.push({ status: 'warning', reason: `No detected profile matches ${compat.frameworks.join(', ')}` });
  }

  let overall: 'compatible' | 'incompatible' | 'warning' = 'compatible';
  if (hits.some((h) => h.status === 'incompatible')) overall = 'incompatible';
  else if (hits.some((h) => h.status === 'warning')) overall = 'warning';

  return {
    schema: PACK_COMPATIBILITY_SCHEMA,
    packageName: pack.packageName,
    packageVersion: pack.packageVersion,
    overall,
    sharkcraftVersion,
    runtime,
    packageManager: pm,
    workspaceProfiles: profiles,
    hits,
  };
}

export function checkAllPacksCompatibility(inspection: ISharkcraftInspection): IPackCompatibility[] {
  return inspection.packs.validPacks.map((p) => checkPackCompatibility(inspection, p));
}
