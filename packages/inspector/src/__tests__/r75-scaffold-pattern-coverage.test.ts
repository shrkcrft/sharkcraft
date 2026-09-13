/**
 * r75 — scaffold `matchPaths` dead selectors (spec 1.3#4).
 *
 * `scaffolds doctor` checked only that each `matchPaths` entry was a non-empty
 * string, so a glob pointing at a renamed directory read healthy forever. The
 * doctor now counts per glob, with THE enumeration `infer templates`
 * attributes candidates with. Real loader, real walk.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import {
  doctorScaffoldPatterns,
  enumerateScaffoldPatternCandidates,
  loadScaffoldPatternsFromInspection,
  matchScaffoldPattern,
  scaffoldPatternCoverage,
  type IScaffoldPatternWithSource,
} from '../scaffold-patterns.ts';

const TIMEOUT_MS = 60_000;
let root = '';
let insp: ISharkcraftInspection;
let patterns: IScaffoldPatternWithSource[];

const pattern = (id: string, matchPaths: string[], extra = ''): string =>
  `{ id: '${id}', title: '${id}', description: 'd', templateId: 'fx.none', matchPaths: ${JSON.stringify(matchPaths)}, variables: [], appliesWhen: ['infer-template'], confidence: 'high'${extra} }`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r75-scaffold-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
    'src/a.ts': 'export const a = 1;\n',
    'src/b.service.ts': 'export class B {}\n',
    'sharkcraft/scaffold-patterns.ts': `export default [
  ${pattern('sp.dead', ['src/old/**/*.service.ts'])},
  ${pattern('sp.live', ['src/*.ts'])},
  ${pattern('sp.half', ['src/*.service.ts', 'lib/**/*.ts'])},
  ${pattern('sp.excluded', ['src/a.ts'], ", excludePaths: ['src/a.ts']")},
];
`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  insp = await inspectSharkcraft({ cwd: root });
  patterns = (await loadScaffoldPatternsFromInspection(insp)).patterns;
}, TIMEOUT_MS);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('r75 scaffold pattern coverage', () => {
  test('a dead pattern → exactly one matchPaths-matched-nothing plus pattern-dead; a live one → none', () => {
    const e = enumerateScaffoldPatternCandidates(insp.projectRoot, patterns);
    const issues = doctorScaffoldPatterns(patterns, insp, e).filter((i) => i.code);
    const of = (id: string) => issues.filter((i) => i.patternId === id).map((i) => `${i.code}|${i.target ?? ''}`);
    expect(of('sp.dead')).toEqual(['matchPaths-matched-nothing|src/old/**/*.service.ts', 'pattern-dead|']);
    expect(of('sp.live')).toEqual([]);
    expect(e.byPattern.get('sp.live')!.files.length).toBeGreaterThanOrEqual(1);
  });

  test('one dead glob beside a live one → one per-unit warning, no pattern-dead', () => {
    const e = enumerateScaffoldPatternCandidates(insp.projectRoot, patterns);
    const issues = doctorScaffoldPatterns(patterns, insp, e).filter((i) => i.code && i.patternId === 'sp.half');
    expect(issues.map((i) => `${i.code}|${i.target}`)).toEqual(['matchPaths-matched-nothing|lib/**/*.ts']);
  });

  test('excludePaths removing every file → pattern-dead, though the glob itself matched', () => {
    const e = enumerateScaffoldPatternCandidates(insp.projectRoot, patterns);
    expect(e.byPattern.get('sp.excluded')!.perMatchPath).toEqual([{ glob: 'src/a.ts', files: 1 }]);
    const issues = doctorScaffoldPatterns(patterns, insp, e).filter((i) => i.code && i.patternId === 'sp.excluded');
    expect(issues.map((i) => i.code)).toEqual(['pattern-dead']);
  });

  test('coverage names every dead unit; back-compat call without coverage adds none', () => {
    const e = enumerateScaffoldPatternCandidates(insp.projectRoot, patterns);
    const { coverage, deadUnits } = scaffoldPatternCoverage(patterns, e);
    const globs = coverage.find((c) => c.unit === 'matchPaths globs')!;
    expect(globs.unexamined).toEqual(['sp.dead: src/old/**/*.service.ts', 'sp.half: lib/**/*.ts']);
    const pats = coverage.find((c) => c.unit === 'patterns')!;
    expect(pats.unexamined).toEqual(['sp.dead', 'sp.excluded']);
    expect(deadUnits).toHaveLength(4);
    expect(doctorScaffoldPatterns(patterns, insp).filter((i) => i.code)).toEqual([]);
  });

  test('one authority: per-pattern files ≡ the runtime matcher over every walked file', () => {
    const e = enumerateScaffoldPatternCandidates(insp.projectRoot, patterns);
    for (const { pattern: p } of patterns) {
      const byMatcher = ['src/a.ts', 'src/b.service.ts', 'sharkcraft/sharkcraft.config.ts', 'sharkcraft/scaffold-patterns.ts', 'package.json']
        .filter((f) => matchScaffoldPattern(p, f))
        .sort();
      expect({ id: p.id, files: [...e.byPattern.get(p.id)!.files].sort() }).toEqual({ id: p.id, files: byMatcher });
    }
    // infer attributes each file to the FIRST matching pattern.
    expect(e.firstMatch.find((m) => m.file === 'src/b.service.ts')?.patternId).toBe('sp.live');
  });

  test('lock: `infer templates` has no private walker — it reads THE enumeration', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'commands', 'infer.command.ts'), 'utf8');
    expect(src).toContain('enumerateScaffoldPatternCandidates(');
    expect(src).not.toMatch(/function walk\(/);
    expect(src).not.toContain('readdirSync');
  });
});
