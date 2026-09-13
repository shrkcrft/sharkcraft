/**
 * r78 — round 15 follow-ups (L1), in process: THE convention file spelling is
 * realpath-canonical (F9), and `INotApplicableConvention.severity` is the
 * `ConventionSeverity` enum (F8).
 *
 * `conventionFilePath` made an absolute path relative to `projectRoot`
 * lexically, so a symlinked spelling of an in-project file (`/link/src/a.ts`
 * with `/link → the project`; macOS `/var/…` for a root at `/private/var/…`)
 * read `../link/src/a.ts` — no `fileGlobs` selected it and the convention was
 * silently not applicable. Now the file and the root are both resolved through
 * their symlinks first. `conventionScope` still RETURNS the caller's spellings
 * (the rule-graph bridge looks its graph paths up in them) while judging the
 * canonical one.
 *
 * Real projects on disk, the real loaders (`inspectSharkcraft` →
 * `listConventions`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { ConventionSeverity, type IConvention } from '@shrkcrft/plugin-api';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { conventionFilePath, conventionScope } from '../convention-applicability.ts';
import { checkConventionsAgainstFiles, listConventions } from '../convention-registry.ts';
import type { INotApplicableConvention } from '../i-not-applicable-convention.ts';

const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

const CONVENTIONS = [
  { id: 'c.src', title: 'c.src', kind: 'naming', severity: 'error', appliesTo: { fileGlobs: ['src/**'] }, rules: [{ id: 'any', description: 'any', forbidMatch: '.' }] },
  ...Object.values(ConventionSeverity).map((severity) => ({
    id: `c.turbo-${severity}`,
    title: severity,
    kind: 'naming',
    severity,
    appliesTo: { profileIds: ['has-turborepo'] },
    rules: [],
  })),
];

/** A TypeScript project on disk, plus a symlink to it (`link`) and a directory outside it (`outside`). */
function fixture(): { root: string; link: string; outside: string } {
  const root = tmp('shrk-r78-conv-realpath-');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'tsconfig.json': '{}',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/conventions.ts': `export default ${JSON.stringify(CONVENTIONS, null, 2)};\n`,
    'src/a.ts': 'export const a = 1;\n',
  };
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  const outside = tmp('shrk-r78-conv-realpath-outside-');
  write(outside, 'x.ts', 'export const x = 1;\n');
  symlinkSync('src', join(root, 'srclink'), 'dir');
  symlinkSync(outside, join(root, 'ext'), 'dir');
  const link = join(tmp('shrk-r78-conv-realpath-link-'), 'link');
  symlinkSync(root, link, 'dir');
  return { root, link, outside };
}

async function srcConvention(insp: ISharkcraftInspection): Promise<IConvention> {
  const entry = (await listConventions(insp)).find((e) => e.convention.id === 'c.src');
  if (!entry) throw new Error('c.src did not load');
  return entry.convention;
}

describe('F9 — conventionFilePath is realpath-canonical', () => {
  test(
    'every spelling of an in-project file reads project-relative; a path leaving the project keeps its lexical spelling',
    async () => {
      const { root, link, outside } = fixture();
      const insp = await inspectSharkcraft({ cwd: root });
      const cases: [string, string][] = [
        ['src/a.ts', 'src/a.ts'],
        ['./src/a.ts', 'src/a.ts'],
        [join(root, 'src/a.ts'), 'src/a.ts'],
        [join(realpathSync(root), 'src/a.ts'), 'src/a.ts'],
        // The symlinked absolute path — the defect: it read `../…/link/src/a.ts`.
        [join(link, 'src/a.ts'), 'src/a.ts'],
        // A file that does not exist resolves through its nearest existing ancestor.
        [join(link, 'src/gone/deep.ts'), 'src/gone/deep.ts'],
        ['lib/missing.ts', 'lib/missing.ts'],
        // An in-project directory symlink reads as its target.
        ['srclink/a.ts', 'src/a.ts'],
        // A symlink whose target leaves the project keeps its in-project spelling.
        ['ext/x.ts', 'ext/x.ts'],
      ];
      for (const [spelling, want] of cases) {
        expect({ spelling, got: conventionFilePath(insp, spelling) }).toEqual({ spelling, got: want });
      }
      // A file genuinely outside the project stays the lexical relative path (no glob selects it).
      const far = join(outside, 'x.ts');
      expect(conventionFilePath(insp, far)).toBe(relative(insp.projectRoot, far).split(sep).join('/'));
    },
    T,
  );

  test(
    'an inspection opened through a symlinked cwd reads a real absolute path project-relative',
    async () => {
      const { root, link } = fixture();
      const insp = await inspectSharkcraft({ cwd: link });
      expect(conventionFilePath(insp, join(realpathSync(root), 'src/a.ts'))).toBe('src/a.ts');
      expect(conventionFilePath(insp, join(link, 'src/a.ts'))).toBe('src/a.ts');
    },
    T,
  );

  test(
    'conventionScope judges the canonical spelling but RETURNS the caller\'s (the bridge contract); check hits name the canonical path',
    async () => {
      const { link } = fixture();
      const insp = await inspectSharkcraft({ cwd: link });
      const c = await srcConvention(insp);
      const viaLink = join(link, 'src/a.ts');
      const scope = conventionScope(c, insp, [viaLink, 'srclink/a.ts']);
      expect(scope.applicable).toBe(true);
      expect(scope.files).toEqual([viaLink, 'srclink/a.ts']);
      const report = await checkConventionsAgainstFiles(insp, [viaLink]);
      expect(report.hits.map((h) => `${h.conventionId}:${h.file}`)).toEqual(['c.src:src/a.ts']);
    },
    T,
  );
});

describe('F8 — INotApplicableConvention.severity is the ConventionSeverity enum', () => {
  test(
    'the engine reports each not-applicable convention with its enum severity',
    async () => {
      const { root } = fixture();
      const insp = await inspectSharkcraft({ cwd: root });
      const report = await checkConventionsAgainstFiles(insp, ['src/a.ts']);
      const na: readonly INotApplicableConvention[] = report.notApplicable;
      // Type-level lock: this assignment fails tsc if `severity` is a union literal again.
      const severities: ConventionSeverity[] = na.map((n) => n.severity);
      expect(severities.sort()).toEqual(Object.values(ConventionSeverity).sort());
    },
    T,
  );
});
