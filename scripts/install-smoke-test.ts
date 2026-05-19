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
  readFileSync,
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

  // 6a. TS-loader regression gate.
  //
  // The init scaffold produces TypeScript files under sharkcraft/ (config,
  // knowledge, rules, paths, templates). If Node's dynamic `import()` can
  // no longer read them — for example because @shrkcrft/core's jiti
  // routing regressed — doctor will silently report "0 entries loaded"
  // and an AI-readiness score in the teens instead of the 60s. That mode
  // *also* still prints "Verdict:" so the older check above can't catch
  // it. The two assertions below pin the contract: post-init, the loaded
  // surface must be non-empty AND the score must clear a floor.
  const entriesMatch = doctor2.match(/knowledge entries[^\n]*?(\d+)\s+entries loaded/);
  const entryCount = entriesMatch ? Number(entriesMatch[1]) : 0;
  if (entryCount <= 0) {
    throw new Error(
      `shrk doctor (post-init) reports ${entryCount} knowledge entries — Node-side TS loader is broken. Doctor output:\n${doctor2}`,
    );
  }
  console.log(`  → knowledge entries loaded: ${entryCount}`);
  const scoreMatch = doctor2.match(/AI-readiness:\s+(\d+)\s*\/\s*100/);
  const score = scoreMatch ? Number(scoreMatch[1]) : 0;
  // 50 is a conservative floor — the init scaffold currently produces
  // ~71. Anything under 50 means a major load path broke.
  if (score < 50) {
    throw new Error(
      `shrk doctor (post-init) AI-readiness ${score}/100 below the 50 floor — likely a Node-side TS loader regression. Doctor output:\n${doctor2}`,
    );
  }
  console.log(`  → AI-readiness: ${score}/100`);

  // 6b. End-to-end `check boundaries` against a user-written TS rule file.
  //     This is the path that silently failed before jiti landed — the
  //     boundaries loader uses dynamic import on a .ts file, and Node
  //     without a TS loader returns no rules.
  console.log('• write sharkcraft/boundaries.ts + npx shrk check boundaries');
  const boundariesFile = join(tmp, 'sharkcraft', 'boundaries.ts');
  writeFileSync(
    boundariesFile,
    [
      '// Smoke-test boundary rule. Verifies the Node-side TS loader can',
      '// read user-authored .ts files end-to-end.',
      'export default [',
      '  {',
      "    id: 'smoke.no-self-import',",
      "    title: 'sentinel rule',",
      "    severity: 'warning',",
      "    from: ['src/**/*.ts'],",
      "    forbiddenImports: ['nonexistent-package-xyz'],",
      "    suggestedFix: 'no-op',",
      '  },',
      '];',
      '',
    ].join('\n'),
    'utf8',
  );
  // The boundary loader only reads files listed in
  // config.boundaryFiles, so make sure the scaffolded config references
  // our sentinel rule file. Patching the init-scaffolded config in place
  // would be fragile (presets emit different shapes); easier and stable
  // to overwrite with a minimal known-good config for the smoke test.
  const cfgPath = join(tmp, 'sharkcraft', 'sharkcraft.config.ts');
  const minimalCfg = [
    '// Smoke-test config. Overwritten by install-smoke-test.ts to make',
    '// the boundary-file assertion deterministic across init scaffolds.',
    'export default {',
    "  projectName: 'smoke-consumer',",
    "  description: 'Install smoke test consumer repo.',",
    "  knowledgeFiles: ['knowledge.ts'],",
    "  ruleFiles: ['rules.ts'],",
    "  pathFiles: ['paths.ts'],",
    "  templateFiles: ['templates.ts'],",
    "  boundaryFiles: ['boundaries.ts'],",
    '  defaultMaxTokens: 3500,',
    '};',
    '',
  ].join('\n');
  writeFileSync(cfgPath, minimalCfg, 'utf8');
  const boundariesOut = capture('npx', tmp, [
    '--no-install',
    'shrk',
    'check',
    'boundaries',
  ]);
  const rulesMatch = boundariesOut.match(/rules\s+(\d+)/);
  const ruleCount = rulesMatch ? Number(rulesMatch[1]) : 0;
  if (ruleCount < 1) {
    throw new Error(
      `shrk check boundaries reported ${ruleCount} rules — TS-rule loader is broken. Output:\n${boundariesOut}`,
    );
  }
  console.log(`  → boundaries rule(s) loaded: ${ruleCount}`);

  // 6c. Node-only probe — invoke the installed CLI explicitly with `node`
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
