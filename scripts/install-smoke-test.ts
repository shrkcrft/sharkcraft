#!/usr/bin/env bun
// Install smoke-test: simulate "fresh user installs the published tarballs"
// against a clean temp directory. Verifies the dist tree, package shapes,
// and the published CLI actually run end-to-end.
//
// Flow:
//   1. bun run build:dist
//   2. For every packages/<short>: swap to publish mode, npm pack to a
//      tarball, restore dev package.json.
//   3. mktemp -d a fresh consumer repo.
//   4. npm init -y in the consumer; install all tarballs.
//   5. Run shrk --version / shrk help / shrk doctor inside the consumer.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverPackages,
  versionsByName,
  withPublishMode,
} from './lib/publish-mode.ts';

const ROOT = process.cwd();
const PACKAGES_DIR = join(ROOT, 'packages');

function run(cmd: string, cwd: string, args: readonly string[] = []): void {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')} (in ${cwd})`);
  }
}

function capture(cmd: string, cwd: string, args: readonly string[] = []): string {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: false });
  if (res.status !== 0) {
    throw new Error(
      `Command failed (${res.status}): ${cmd} ${args.join(' ')}\n${res.stderr ?? ''}${res.stdout ?? ''}`,
    );
  }
  return (res.stdout ?? '').toString();
}

async function main(): Promise<void> {
  // 1. Build dist.
  console.log('• build:dist');
  run('bun', ROOT, ['run', 'build:dist']);

  // 2. Pack every package — temporarily swap package.json to publish mode.
  const packs = discoverPackages(PACKAGES_DIR).filter((p) => !p.private);
  const versionByName = versionsByName(packs);
  const tarballsDir = join(ROOT, '.tmp-pack');
  rmSync(tarballsDir, { recursive: true, force: true });
  mkdirSync(tarballsDir, { recursive: true });
  const tarballs: string[] = [];
  for (const p of packs) {
    console.log(`• npm pack ${p.name}@${p.version}`);
    const tarball = await withPublishMode(p.dir, versionByName, () => {
      const out = capture('npm', p.dir, ['pack', '--pack-destination', tarballsDir, '--json']);
      const parsed = JSON.parse(out) as Array<{ filename: string }>;
      const file = parsed[0]?.filename;
      if (!file) throw new Error(`npm pack returned no filename for ${p.name}`);
      return join(tarballsDir, file);
    });
    tarballs.push(tarball);
  }

  // 3. Temp consumer.
  const tmp = mkdtempSync(join(tmpdir(), 'shrk-smoke-'));
  console.log(`• consumer dir ${tmp}`);
  run('npm', tmp, ['init', '-y']);

  // 4. Install — give npm every tarball at once so it resolves their
  //    inter-package @shrkcrft/* deps against each other locally.
  console.log('• npm install <tarballs>');
  run('npm', tmp, ['install', '--no-fund', '--no-audit', ...tarballs]);

  // 5. Run shrk via npx.
  console.log('• npx shrk --version');
  const version = capture('npx', tmp, ['--no-install', 'shrk', '--version']);
  if (!/\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Unexpected --version output: ${version}`);
  }
  console.log(`  → ${version.trim()}`);

  console.log('• npx shrk help');
  const help = capture('npx', tmp, ['--no-install', 'shrk', 'help']);
  // R56-followup — start screen pruned to core tier verbs.
  // gen / export / apply are extended; discoverable via `shrk surface list`.
  for (const expected of ['SharkCraft CLI', 'doctor', 'context', 'surface list']) {
    if (!help.includes(expected)) {
      throw new Error(`shrk help missing "${expected}"`);
    }
  }

  // shrk doctor: a brand-new consumer has no sharkcraft/ folder. The
  // command should still exit cleanly with a clear "setup missing" verdict.
  console.log('• npx shrk doctor');
  const doctor = spawnSync('npx', ['--no-install', 'shrk', 'doctor'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  console.log(doctor.stdout?.toString().split('\n').slice(-8).join('\n'));
  if (doctor.status !== 0 && doctor.status !== 1) {
    throw new Error(`shrk doctor crashed (exit ${doctor.status})`);
  }

  // 6. Init scaffolds and re-doctor.
  console.log('• npx shrk init && npx shrk doctor');
  run('npx', tmp, ['--no-install', 'shrk', 'init']);
  const doctor2 = capture('npx', tmp, ['--no-install', 'shrk', 'doctor']);
  if (!doctor2.includes('Verdict:')) {
    throw new Error('shrk doctor (post-init) missing Verdict line');
  }

  // 6b. Node-only probe — invoke the installed CLI explicitly with `node`
  //     so we catch any regression to a Bun-required shebang even when bun
  //     is on PATH.
  console.log('• node node_modules/@shrkcrft/cli/dist/main.js --version');
  const nodeVersion = capture('node', tmp, [
    'node_modules/@shrkcrft/cli/dist/main.js',
    '--version',
  ]);
  if (!/\d+\.\d+\.\d+/.test(nodeVersion)) {
    throw new Error(`Node-direct invocation produced unexpected output: ${nodeVersion}`);
  }
  console.log(`  → ${nodeVersion.trim()} (Node-direct)`);

  // 7. Cleanup tarballs (consumer dir stays for inspection).
  rmSync(tarballsDir, { recursive: true, force: true });
  console.log(`\n✓ Install smoke test passed. Consumer left at: ${tmp}`);
  writeFileSync(join(ROOT, '.tmp-smoke-consumer.txt'), tmp + '\n', 'utf8');
}

main().catch((err) => {
  console.error('install-smoke-test failed:', err);
  process.exit(1);
});
