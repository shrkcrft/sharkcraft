/**
 * Smoke coverage for the NestJS 11+ preset family.
 *
 *   - All eight presets are registered in BUILTIN_PRESETS and reachable
 *     by id.
 *   - The comprehensive `nest-11-modern` preset composes the seven
 *     focused ones.
 *   - Each focused preset includes the canonical rule for its area
 *     (e.g. the security preset includes the helmet rule).
 *   - Every emitted .ts file in the synthesized output is self-contained
 *     — no `@shrkcrft/*` imports.
 *   - The recommender prefers nest-11-modern over the legacy
 *     nestjs-service / nest-service aliases when the workspace declares
 *     HasNestJS + IsBackend + IsService.
 */
import { describe, expect, test } from 'bun:test';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import {
  BUILTIN_PRESETS,
  recommendPresets,
  synthesizePresetFiles,
} from '../index.ts';
import { NEST_11_PRESETS } from '../builtin/nest11-presets.ts';

const NEST11_IDS = [
  'nest-11-architecture',
  'nest-11-validation',
  'nest-11-async-lifecycle',
  'nest-11-performance',
  'nest-11-security',
  'nest-11-observability',
  'nest-11-testing',
  'nest-11-modern',
] as const;

describe('NestJS 11+ preset family — registration', () => {
  test('all eight presets are exported and shipped in BUILTIN_PRESETS', () => {
    expect(NEST_11_PRESETS).toHaveLength(8);
    const builtinIds = new Set(BUILTIN_PRESETS.map((p) => p.id));
    for (const id of NEST11_IDS) {
      expect(builtinIds.has(id), `${id} not in BUILTIN_PRESETS`).toBe(true);
    }
  });

  test('preset ids are unique within the family', () => {
    const ids = NEST_11_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('nest-11-modern composes the seven focused presets', () => {
    const comp = BUILTIN_PRESETS.find((p) => p.id === 'nest-11-modern');
    expect(comp).toBeDefined();
    expect(comp!.composes).toBeDefined();
    const composes = new Set(comp!.composes ?? []);
    expect(composes.has('nest-11-architecture')).toBe(true);
    expect(composes.has('nest-11-validation')).toBe(true);
    expect(composes.has('nest-11-async-lifecycle')).toBe(true);
    expect(composes.has('nest-11-performance')).toBe(true);
    expect(composes.has('nest-11-security')).toBe(true);
    expect(composes.has('nest-11-observability')).toBe(true);
    expect(composes.has('nest-11-testing')).toBe(true);
  });
});

describe('NestJS 11+ preset family — canonical rules', () => {
  function rulesSourceFor(presetId: string): string {
    const preset = BUILTIN_PRESETS.find((p) => p.id === presetId);
    expect(preset, `${presetId} missing`).toBeDefined();
    return (preset!.includes.rules ?? []).join('\n');
  }

  test('nest-11-architecture includes thin-controllers + service-owns-domain + module rules', () => {
    const src = rulesSourceFor('nest-11-architecture');
    expect(src).toContain('thin');
    expect(src).toContain('Services own domain logic');
    expect(src).toContain('Module per feature');
    expect(src).toContain('public API');
    expect(src).toContain('DTOs at the HTTP boundary');
  });

  test('nest-11-validation includes the global ValidationPipe + class-validator + DTO rules', () => {
    const src = rulesSourceFor('nest-11-validation');
    expect(src).toContain('ValidationPipe');
    expect(src).toContain('whitelist');
    expect(src).toContain('forbidNonWhitelisted');
    expect(src).toContain('class-validator');
    expect(src).toContain('PartialType');
  });

  test('nest-11-async-lifecycle includes shutdown hooks + lifecycle + async-providers rules', () => {
    const src = rulesSourceFor('nest-11-async-lifecycle');
    expect(src).toContain('enableShutdownHooks');
    expect(src).toContain('OnModuleDestroy');
    expect(src).toContain('useFactory');
  });

  test('nest-11-performance includes Fastify + cache-manager + throttler + pagination', () => {
    const src = rulesSourceFor('nest-11-performance');
    expect(src).toContain('FastifyAdapter');
    expect(src).toContain('CacheInterceptor');
    expect(src).toContain('ThrottlerModule');
    expect(src).toContain('pageSize');
  });

  test('nest-11-security includes helmet + explicit CORS + JWT guards + no-secrets', () => {
    const src = rulesSourceFor('nest-11-security');
    expect(src).toContain('helmet');
    expect(src).toContain('CORS');
    expect(src).toContain('JwtAuthGuard');
    expect(src).toContain('secret');
    expect(src).toContain('trust-proxy');
  });

  test('nest-11-observability includes Logger context + structured logs + terminus', () => {
    const src = rulesSourceFor('nest-11-observability');
    expect(src).toContain('Logger');
    expect(src).toContain('pino');
    expect(src).toContain('terminus');
    expect(src).toContain('liveness');
    expect(src).toContain('readiness');
  });

  test('nest-11-testing includes TestingModule + supertest + file-layout rules', () => {
    const src = rulesSourceFor('nest-11-testing');
    expect(src).toContain('TestingModule');
    expect(src).toContain('overrideProvider');
    expect(src).toContain('supertest');
    expect(src).toContain('e2e-spec.ts');
  });

  test('nest-11-modern includes API versioning on top of the composed family', () => {
    const src = rulesSourceFor('nest-11-modern');
    expect(src).toContain('enableVersioning');
  });
});

describe('NestJS 11+ preset family — synthesis', () => {
  test('every preset synthesizes self-contained .ts files', () => {
    const bad = /from\s+['"]@shrkcrft\//;
    const typo = /from\s+['"]@sharkcraft\//;
    for (const preset of NEST_11_PRESETS) {
      const files = synthesizePresetFiles(preset);
      for (const f of files) {
        if (!f.path.endsWith('.ts')) continue;
        expect(
          f.content,
          `${preset.id}/${f.path} must not import from @shrkcrft/*`,
        ).not.toMatch(bad);
        expect(
          f.content,
          `${preset.id}/${f.path} must not contain @sharkcraft/* typo`,
        ).not.toMatch(typo);
      }
    }
  });

  test('every preset emits a paths.ts file with Nest src path', () => {
    for (const preset of NEST_11_PRESETS) {
      const files = synthesizePresetFiles(preset);
      const pathsFile = files.find((f) => f.path === 'paths.ts');
      expect(pathsFile, `${preset.id} missing paths.ts`).toBeDefined();
      // Every preset must reference the canonical Nest src/ root. The
      // architecture/testing/modern presets also include test/, the
      // others stick to src/ alone.
      expect(pathsFile!.content).toContain("metadata: { path: 'src' }");
    }
  });
});

describe('NestJS 11+ preset family — recommendation', () => {
  test('recommendPresets prefers nest-11-modern for a Nest backend workspace', () => {
    const recs = recommendPresets([...BUILTIN_PRESETS], {
      profiles: [
        WorkspaceProfile.HasNestJS,
        WorkspaceProfile.IsBackend,
        WorkspaceProfile.IsService,
      ],
      limit: 3,
    });
    const top = recs[0]?.preset?.id ?? '';
    expect(
      [
        'nest-11-modern',
        'nest-11-architecture',
        'nest-11-validation',
        'nest-11-performance',
        'nest-11-security',
      ],
      `expected a nest-11-* preset to win; got "${top}"`,
    ).toContain(top);
  });
});
