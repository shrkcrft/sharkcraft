import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPackageJson } from './package-json-reader.ts';
import { FrameworkId } from './framework-id.ts';

export interface IFrameworkInfo {
  id: string;
  name: string;
  version?: string;
  evidence: string[];
}

interface FrameworkDef {
  id: FrameworkId;
  name: string;
  packages: string[];
  fileMarkers?: string[];
}

/**
 * One definition per {@link FrameworkId} — keyed by the enum, so a vocabulary
 * member without a detector definition (or the reverse) is a compile error.
 * Insertion order is the detection (and output) order.
 */
const FRAMEWORK_DEFS: Readonly<Record<FrameworkId, Omit<FrameworkDef, 'id'>>> = {
  [FrameworkId.Angular]: { name: 'Angular', packages: ['@angular/core', '@angular/cli'], fileMarkers: ['angular.json'] },
  [FrameworkId.React]: { name: 'React', packages: ['react'] },
  [FrameworkId.Vue]: { name: 'Vue', packages: ['vue'] },
  [FrameworkId.Svelte]: { name: 'Svelte', packages: ['svelte'] },
  [FrameworkId.NextJs]: { name: 'Next.js', packages: ['next'] },
  [FrameworkId.Nuxt]: { name: 'Nuxt', packages: ['nuxt'] },
  [FrameworkId.NestJs]: { name: 'NestJS', packages: ['@nestjs/core'] },
  [FrameworkId.Express]: { name: 'Express', packages: ['express'] },
  [FrameworkId.Fastify]: { name: 'Fastify', packages: ['fastify'] },
  [FrameworkId.Nx]: { name: 'Nx', packages: ['nx', '@nx/workspace'], fileMarkers: ['nx.json'] },
  [FrameworkId.AwsLambda]: { name: 'AWS Lambda', packages: ['aws-lambda', '@types/aws-lambda'] },
  [FrameworkId.Electron]: { name: 'Electron', packages: ['electron'] },
  [FrameworkId.TypeScript]: {
    name: 'TypeScript',
    packages: ['typescript'],
    fileMarkers: ['tsconfig.json', 'tsconfig.base.json'],
  },
  [FrameworkId.Bun]: { name: 'Bun', packages: ['bun-types', '@types/bun'], fileMarkers: ['bun.lockb', 'bun.lock'] },
};

const FRAMEWORKS: readonly FrameworkDef[] = (Object.keys(FRAMEWORK_DEFS) as FrameworkId[]).map((id) => ({
  id,
  ...FRAMEWORK_DEFS[id],
}));

/**
 * Every framework id the detector can report — THE vocabulary an
 * `appliesTo.frameworks` filter may name (the {@link FrameworkId} values, in
 * detection order). The vocabulary is not per repo: an id is valid whether or
 * not THIS repo uses the framework (`inspection.workspace.frameworks`).
 */
export function listFrameworkIds(): readonly FrameworkId[] {
  return FRAMEWORKS.map((f) => f.id);
}

/** Is `id` a member of THE framework vocabulary ({@link listFrameworkIds})? */
export function isFrameworkId(id: string): id is FrameworkId {
  return (Object.values(FrameworkId) as string[]).includes(id);
}

export function detectFrameworks(projectRoot: string, pkg: IPackageJson | null): IFrameworkInfo[] {
  const out: IFrameworkInfo[] = [];
  const allDeps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
  };

  for (const def of FRAMEWORKS) {
    const evidence: string[] = [];
    let version: string | undefined;

    for (const pkgName of def.packages) {
      if (pkgName in allDeps) {
        evidence.push(`depends on ${pkgName}`);
        version = version ?? allDeps[pkgName];
      }
    }
    for (const marker of def.fileMarkers ?? []) {
      if (existsSync(nodePath.join(projectRoot, marker))) {
        evidence.push(`${marker} exists`);
      }
    }
    if (evidence.length > 0) {
      out.push({ id: def.id, name: def.name, version, evidence });
    }
  }

  return out;
}
