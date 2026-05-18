import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { IPackageJson } from './package-json-reader.ts';

export interface IFrameworkInfo {
  id: string;
  name: string;
  version?: string;
  evidence: string[];
}

interface FrameworkDef {
  id: string;
  name: string;
  packages: string[];
  fileMarkers?: string[];
}

const FRAMEWORKS: FrameworkDef[] = [
  { id: 'angular', name: 'Angular', packages: ['@angular/core', '@angular/cli'], fileMarkers: ['angular.json'] },
  { id: 'react', name: 'React', packages: ['react'] },
  { id: 'vue', name: 'Vue', packages: ['vue'] },
  { id: 'svelte', name: 'Svelte', packages: ['svelte'] },
  { id: 'nextjs', name: 'Next.js', packages: ['next'] },
  { id: 'nuxt', name: 'Nuxt', packages: ['nuxt'] },
  { id: 'nestjs', name: 'NestJS', packages: ['@nestjs/core'] },
  { id: 'express', name: 'Express', packages: ['express'] },
  { id: 'fastify', name: 'Fastify', packages: ['fastify'] },
  { id: 'nx', name: 'Nx', packages: ['nx', '@nx/workspace'], fileMarkers: ['nx.json'] },
  { id: 'aws-lambda', name: 'AWS Lambda', packages: ['aws-lambda', '@types/aws-lambda'] },
  { id: 'electron', name: 'Electron', packages: ['electron'] },
  { id: 'typescript', name: 'TypeScript', packages: ['typescript'], fileMarkers: ['tsconfig.json', 'tsconfig.base.json'] },
  { id: 'bun', name: 'Bun', packages: ['bun-types', '@types/bun'], fileMarkers: ['bun.lockb', 'bun.lock'] },
];

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
