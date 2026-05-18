/**
 * Surface profile auto-detection at init + doctor drift advisory.
 *
 *   - suggestSurfaceProfile() maps `single-package` → `small-app`.
 *   - suggestSurfaceProfile() maps `nx` → `monorepo`.
 *   - --surface-profile <id> override flag wins over detection.
 *   - injected `surface.profile` lands in the generated
 *     sharkcraft.config.ts.
 *   - doctor surfaces an advisory when configured profile diverges
 *     from the workspace shape.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import {
  inspectSharkcraft,
  runDoctor,
  suggestSurfaceProfile,
  SurfaceProfile,
} from '@shrkcrft/inspector';
import { initCommand } from '../commands/init.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const TMP_BASE = nodePath.join('/tmp', 'r58-surface-profile');
let projectRoot: string;

function makeArgs(flags: Record<string, string | boolean> = {}): ParsedArgs {
  const m = new Map<string, string | boolean>();
  for (const [k, v] of Object.entries(flags)) m.set(k, v);
  return {
    positional: [],
    flags: m,
    multiFlags: new Map(),
    globalCwd: projectRoot,
  };
}

async function silenceStdout<T>(fn: () => Promise<T> | T): Promise<T> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((_chunk: string | Uint8Array): boolean => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
}

beforeEach(() => {
  projectRoot = nodePath.join(
    TMP_BASE,
    `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    nodePath.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'r58-fixture', version: '0.0.0', private: true }),
  );
});

afterEach(() => {
  if (projectRoot && existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

describe('surface profile detection + init wiring', () => {
  test('suggestSurfaceProfile maps single-package → small-app', () => {
    const sug = suggestSurfaceProfile(['single-package', 'typescript']);
    expect(sug.profile).toBe(SurfaceProfile.SmallApp);
    expect(sug.reason).toMatch(/single-package/);
  });

  test('suggestSurfaceProfile maps nx → monorepo', () => {
    const sug = suggestSurfaceProfile(['nx', 'typescript']);
    expect(sug.profile).toBe(SurfaceProfile.Monorepo);
  });

  test('suggestSurfaceProfile falls back to developer when no signal matches', () => {
    const sug = suggestSurfaceProfile(['typescript']);
    expect(sug.profile).toBe(SurfaceProfile.Developer);
  });

  test('shrk init --surface-profile <id> writes the override into the config', async () => {
    const rc = await silenceStdout(() =>
      initCommand.run(makeArgs({ 'surface-profile': 'monorepo', write: true })),
    );
    expect(rc).toBe(0);
    const cfg = readFileSync(
      nodePath.join(projectRoot, 'sharkcraft', 'sharkcraft.config.ts'),
      'utf8',
    );
    expect(cfg).toContain('profile: "monorepo"');
    expect(cfg).toContain('surface.profile picked by `shrk init`');
  });

  test('shrk init rejects an unknown --surface-profile', async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    let stderr = '';
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stderr.write;
    try {
      const rc = await silenceStdout(() =>
        initCommand.run(makeArgs({ 'surface-profile': 'nonsense', write: true })),
      );
      expect(rc).toBe(2);
      expect(stderr).toContain('Unknown --surface-profile');
    } finally {
      process.stderr.write = origErr;
    }
  });

  test('doctor surfaces an advisory when configured profile diverges from detected', async () => {
    // Write a minimal config that names a profile that won't match the
    // actual fixture (which has no nx/pnpm signal, so detection returns
    // `developer` — we configure `monorepo` to force a drift).
    mkdirSync(nodePath.join(projectRoot, 'sharkcraft'), { recursive: true });
    writeFileSync(
      nodePath.join(projectRoot, 'sharkcraft', 'sharkcraft.config.ts'),
      `export default {
  projectName: 'r58-drift-fixture',
  knowledgeFiles: [],
  ruleFiles: [],
  pathFiles: [],
  templateFiles: [],
  pipelineFiles: [],
  surface: { profile: 'monorepo', enabled: [], hidden: [] },
};
`,
    );
    const inspection = await inspectSharkcraft({ cwd: projectRoot });
    const doctor = runDoctor(inspection);
    const drift = doctor.checks.find((c) => c.id === 'surface-profile-drift');
    expect(drift).toBeDefined();
    expect(drift!.advisory).toBe(true);
    expect(drift!.message).toContain('monorepo');
  });
});
