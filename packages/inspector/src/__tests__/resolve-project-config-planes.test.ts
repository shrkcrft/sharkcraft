/**
 * P4 — pack contribution seam for the four "cross-file invariant as DATA"
 * planes (wiringRules / registries / policyRules / reusePrimitives).
 *
 * A framework pack can SHIP these planes via the new manifest slots; the
 * inspector's `resolveProjectConfig` merges them over the local
 * `sharkcraft.config.ts` (LOCAL-WINS), validating each pack element with the
 * same exported zod schema the config loader uses. Missing files, schema-
 * invalid elements, and key collisions become diagnostics — never a crash.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import { resolveProjectConfig } from '../resolve-project-config.ts';

/**
 * Build a workspace whose local config declares all four planes and whose
 * installed pack `@p4/plane-pack` contributes to all four — including a
 * colliding rule, a schema-invalid rule, and a missing file.
 */
function makeWorkspace(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-p4-'));

  // Project-root marker so detectProjectRoot stops here.
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'p4-workspace', version: '0.0.0' }),
  );

  // Local sharkcraft config — two local wiring rules (one of which collides
  // by id with a pack rule), plus a local registry / policy / reuse entry.
  const skDir = nodePath.join(root, 'sharkcraft');
  mkdirSync(skDir, { recursive: true });
  writeFileSync(
    nodePath.join(skDir, 'sharkcraft.config.ts'),
    `export default {
  wiringRules: [
    { id: 'local-wiring', declared: { files: ['src/**/*.ts'], pattern: "decorate\\\\('([^']+)'\\\\)" }, registered: { files: ['mod/**/*.ts'], pattern: "register\\\\('([^']+)'\\\\)" } },
    { id: 'shared-wiring', declared: { files: ['src/**/*.ts'], pattern: "local\\\\('([^']+)'\\\\)" }, registered: { files: ['mod/**/*.ts'], pattern: "reg\\\\('([^']+)'\\\\)" } },
  ],
  registries: [
    { name: 'local-reg', source: { files: ['src/**/*.ts'], pattern: "id:\\\\s*'([^']+)'" } },
  ],
  policyRules: [
    { id: 'local-policy', surface: 'template', pattern: '<button', message: 'no raw button' },
  ],
  reusePrimitives: [
    { symbol: 'LocalButton', roles: ['button'] },
  ],
};
`,
  );

  // Installed pack contributing all four planes.
  const packRoot = nodePath.join(root, 'node_modules/@p4/plane-pack');
  mkdirSync(packRoot, { recursive: true });
  writeFileSync(
    nodePath.join(packRoot, 'package.json'),
    JSON.stringify({
      name: '@p4/plane-pack',
      version: '0.0.1',
      sharkcraft: { manifest: './sharkcraft.plugin.ts' },
    }),
  );
  writeFileSync(
    nodePath.join(packRoot, 'sharkcraft.plugin.ts'),
    `export default {
  schema: 'sharkcraft.pack/v1',
  info: { name: '@p4/plane-pack', version: '0.0.1' },
  contributions: {
    wiringRuleFiles: ['./wiring.ts', './missing-wiring.ts'],
    registryFiles: ['./registries.ts'],
    policyRuleFiles: ['./policy.ts'],
    reusePrimitiveFiles: ['./reuse.ts'],
  },
};
`,
  );
  // wiring.ts: a new rule, a colliding rule (id 'shared-wiring'), and a
  // schema-invalid rule (declared.pattern has NO capture group).
  writeFileSync(
    nodePath.join(packRoot, 'wiring.ts'),
    `export default [
  { id: 'pack-wiring', declared: { files: ['src/**/*.ts'], pattern: "inject\\\\('([^']+)'\\\\)" }, registered: { files: ['mod/**/*.ts'], pattern: "module\\\\('([^']+)'\\\\)" } },
  { id: 'shared-wiring', declared: { files: ['x/**/*.ts'], pattern: "p\\\\('([^']+)'\\\\)" }, registered: { files: ['y/**/*.ts'], pattern: "q\\\\('([^']+)'\\\\)" } },
  { id: 'bad-wiring', declared: { files: ['src/**/*.ts'], pattern: "nocapturegroup" }, registered: { files: ['mod/**/*.ts'], pattern: "m\\\\('([^']+)'\\\\)" } },
];
`,
  );
  writeFileSync(
    nodePath.join(packRoot, 'registries.ts'),
    `export default [
  { name: 'pack-reg', source: { files: ['lib/**/*.ts'], pattern: "name:\\\\s*'([^']+)'" } },
];
`,
  );
  writeFileSync(
    nodePath.join(packRoot, 'policy.ts'),
    `export default [
  { id: 'pack-policy', surface: 'style', pattern: 'color:\\\\s*red', message: 'no raw red' },
];
`,
  );
  writeFileSync(
    nodePath.join(packRoot, 'reuse.ts'),
    `export default [
  { symbol: 'PackButton', roles: ['button', 'cta'] },
];
`,
  );
  return root;
}

describe('resolveProjectConfig — pack-plane merge', () => {
  beforeEach(() => clearPackDiscoveryCache());

  test('merges local + pack rules across all four planes (local-wins)', async () => {
    const root = makeWorkspace();
    try {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const cfg = resolved.value.config;
      const diags = resolved.value.planeDiagnostics;

      // wiringRules — local 'local-wiring' AND pack 'pack-wiring' both present.
      const wiringIds = (cfg.wiringRules ?? []).map((r) => r.id);
      expect(wiringIds).toContain('local-wiring');
      expect(wiringIds).toContain('pack-wiring');

      // registries / policyRules / reusePrimitives each carry local + pack.
      const regNames = (cfg.registries ?? []).map((r) => r.name);
      expect(regNames).toContain('local-reg');
      expect(regNames).toContain('pack-reg');

      const policyIds = (cfg.policyRules ?? []).map((r) => r.id);
      expect(policyIds).toContain('local-policy');
      expect(policyIds).toContain('pack-policy');

      const reuseSymbols = (cfg.reusePrimitives ?? []).map((r) => r.symbol);
      expect(reuseSymbols).toContain('LocalButton');
      expect(reuseSymbols).toContain('PackButton');

      // No fatal diagnostics about discovery itself.
      expect(diags.some((d) => d.includes('pack discovery failed'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a pack rule colliding with a local id is dropped (local-wins) with a diagnostic naming the pack', async () => {
    const root = makeWorkspace();
    try {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const wiring = resolved.value.config.wiringRules ?? [];

      // Exactly one 'shared-wiring' — the LOCAL one (its declared pattern uses
      // "local('…')", the pack's uses "p('…')").
      const shared = wiring.filter((r) => r.id === 'shared-wiring');
      expect(shared.length).toBe(1);
      expect(shared[0]!.declared.pattern).toContain('local');

      const collisionDiag = resolved.value.planeDiagnostics.find(
        (d) => d.includes('shared-wiring') && d.includes('already provided by local config'),
      );
      expect(collisionDiag).toBeDefined();
      expect(collisionDiag).toContain('@p4/plane-pack');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a schema-invalid pack rule is skipped with a diagnostic (no crash)', async () => {
    const root = makeWorkspace();
    try {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const wiringIds = (resolved.value.config.wiringRules ?? []).map((r) => r.id);
      // 'bad-wiring' has a pattern with no capture group → rejected by the
      // exported WiringRuleSchema → never merged.
      expect(wiringIds).not.toContain('bad-wiring');

      const invalidDiag = resolved.value.planeDiagnostics.find(
        (d) => d.includes('invalid wiringRule') && d.includes('@p4/plane-pack'),
      );
      expect(invalidDiag).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a missing pack file yields a diagnostic', async () => {
    const root = makeWorkspace();
    try {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const missingDiag = resolved.value.planeDiagnostics.find(
        (d) => d.includes('missing wiringRule file') && d.includes('missing-wiring.ts'),
      );
      expect(missingDiag).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns the loader error untouched when there is no sharkcraft folder', async () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-p4-noconfig-'));
    try {
      writeFileSync(
        nodePath.join(root, 'package.json'),
        JSON.stringify({ name: 'no-sk', version: '0.0.0' }),
      );
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
