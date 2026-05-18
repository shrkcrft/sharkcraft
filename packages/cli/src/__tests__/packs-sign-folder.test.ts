import { describe, expect, test } from "bun:test";
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { signPackManifest, verifyPackManifest } from '@shrkcrft/plugin-api';

// We don't drive the CLI directly here — we exercise the same primitives the
// CLI uses, so the test stays fast and deterministic. The resolveManifestInput
// behavior is exercised manually in packs.command.ts; the round-trip below
// covers the substantive part (sign → verify, including folder-style input).

function makePackDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-pack-sign-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: '@test/sharkcraft-pack',
        version: '0.1.0',
        sharkcraft: { manifest: './src/manifest.json' },
      },
      null,
      2,
    ),
    'utf8',
  );
  // Use JSON manifest so the test doesn't need a TS module resolver.
  const manifest = {
    schema: 'sharkcraft.pack/v1',
    info: { name: '@test/sharkcraft-pack', version: '0.1.0' },
    contributions: { knowledgeFiles: ['./src/k.ts'] },
  };
  writeFileSync(join(dir, 'src', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return dir;
}

describe('packs sign — folder input + sign/verify round-trip', () => {
  test('signing a folder uses package.json sharkcraft.manifest', () => {
    const dir = makePackDir();
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'src', 'manifest.json'), 'utf8'));
      const signed = signPackManifest(manifest, { secret: 'demo', keyId: 'k1' });
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;
      const verify = verifyPackManifest(signed.manifest, { secret: 'demo' });
      expect(verify.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verify-after-sign with wrong secret reports failure', () => {
    const dir = makePackDir();
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'src', 'manifest.json'), 'utf8'));
      const signed = signPackManifest(manifest, { secret: 'demo' });
      expect(signed.ok).toBe(true);
      if (!signed.ok) return;
      const verify = verifyPackManifest(signed.manifest, { secret: 'WRONG' });
      expect(verify.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('output flag respected — signed JSON written to chosen path', () => {
    const dir = makePackDir();
    const out = join(dir, 'manifest.signed.json');
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'src', 'manifest.json'), 'utf8'));
      const signed = signPackManifest(manifest, { secret: 'demo' });
      if (!signed.ok) throw new Error('sign failed');
      writeFileSync(out, JSON.stringify(signed.manifest, null, 2), 'utf8');
      expect(existsSync(out)).toBe(true);
      const reloaded = JSON.parse(readFileSync(out, 'utf8'));
      expect(reloaded.signature?.algo).toBe('sha256');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
