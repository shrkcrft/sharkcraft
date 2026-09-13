/**
 * r75 — DO-NOT-REGRESS characterization locks for the surfaces round 11 edits.
 *
 * Round 11 rewrites exactly the renderers below: the subset-verdict advisory
 * (1.2), the boundary pattern language and renderer (1.5 / 4.4 / 6.1a), the
 * recommender headline (2.1) and the tuning doctor (3.5). The spec's own
 * "Verified working this round — do NOT regress" list names these outputs as
 * the reason each defect was findable at all, and before this file nothing
 * enforced them at the surface a consumer reads.
 *
 * What is locked is the PRESERVED behaviour only: structure and content that
 * must survive the round. Nothing here asserts a verdict status string or an
 * exit code on a scope round 11 is deliberately changing (a registered ⊋
 * declared subset rule, an empty scope, the recommend headline). A lock that
 * pinned those would fight the fix instead of guarding the output.
 *
 * Every fixture is a mkdtemp workspace with a real sharkcraft/ directory,
 * driven through the real command handlers or the CLI spawned from source.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { explainSearchTuning, inspectSharkcraft } from '@shrkcrft/inspector';
import { gatesExplainCommand } from '../commands/gates.command.ts';
import type { ParsedArgs } from '../command-registry.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const IN_PROCESS_TIMEOUT_MS = 30_000;
const SPAWN_TIMEOUT_MS = 90_000;

/** One printed site: `  • <token>  (<file>:<line>)`. */
const SITE_LINE = /^ {2}• (\S+) {2}\(([^()\s]+):(\d+)\)$/;

interface ISpawnResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function shrk(cwd: string, argv: readonly string[]): ISpawnResult {
  const res = spawnSync('bun', ['run', CLI_MAIN, ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

function capture(): () => string {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let body = '';
  const sink = ((c: string | Uint8Array): boolean => {
    body += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    return body;
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const restore = capture();
  try {
    const code = await h.run(a);
    return { code, out: restore() };
  } catch (e) {
    restore();
    throw e;
  }
}

/** A throwaway workspace: package.json plus every `rel → body` file given. */
function workspace(prefix: string, files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), `shrk-r75-${prefix}-`));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** The lines printed under one `<label> (N):` heading, up to the next blank line. */
function sectionLines(out: string, label: string): string[] {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${label} (`));
  if (start < 0) return [];
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') break;
    body.push(l);
  }
  return body;
}

/**
 * Two wiring rules over the same declared set, plus a registry over it:
 *   • `handlers-registered` — registered set EQUALS declared (status-stable);
 *   • `handlers-wide`       — registered ⊋ declared (C_H is registered but no
 *     declared file exports it) — the exact 1.2 subset shape, whose verdict
 *     round 11 changes, so only its printed counts are asserted.
 */
function explainFixture(): string {
  return workspace('explain', {
    'src/handlers/a.ts': 'export const A_H = 1;\n',
    'src/handlers/b.ts': 'export const B_H = 2;\n',
    'src/reg.ts': 'export const H = [A_H, B_H];\n',
    'src/reg-wide.ts': 'export const H = [A_H, B_H, C_H];\n',
    'sharkcraft/sharkcraft.config.ts': `export default {
  wiringRules: [
    {
      id: 'handlers-registered',
      declared: { files: ['src/handlers/*.ts'], extract: 'export-names', match: '_H$' },
      registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' },
    },
    {
      id: 'handlers-wide',
      declared: { files: ['src/handlers/*.ts'], extract: 'export-names', match: '_H$' },
      registered: { files: ['src/reg-wide.ts'], extract: 'array-members', anchor: 'H' },
    },
  ],
  registries: [
    { name: 'handler-ids', source: { files: ['src/handlers/*.ts'], extract: 'export-names', match: '_H$' } },
  ],
};
`,
  });
}

/** 55 declared + 55 registered sites — past the 50-line text cap. */
function cappedFixture(): string {
  const names = Array.from({ length: 55 }, (_, i) => `T${String(i + 1).padStart(2, '0')}_H`);
  return workspace('cap', {
    'src/handlers/many.ts': names.map((n, i) => `export const ${n} = ${i + 1};\n`).join(''),
    'src/reg.ts': `export const H = [${names.join(', ')}];\n`,
    'sharkcraft/sharkcraft.config.ts': `export default {
  wiringRules: [{
    id: 'many-registered',
    declared: { files: ['src/handlers/*.ts'], extract: 'export-names', match: '_H$' },
    registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' },
  }],
};
`,
  });
}

/*
 * Spec bullet protected by every test in this block:
 *
 *   "`gates explain` still prints the actual extracted set — every declared
 *    site with `file:line`, `declared N / registered M`. It is the reason item
 *    1.2's subset defect was findable at all: the two disagreeing counts were
 *    printed on the same line as the `passed` verdict. Preserve this
 *    everywhere; it is the single most valuable output in the tool."
 */
describe('r75 do-not-regress — `gates explain` prints the extracted set', () => {
  test(
    'prints declared/registered distinct counts and EVERY site as `• <token>  (<file>:<line>)`',
    async () => {
      const root = explainFixture();
      try {
        const { out } = await run(gatesExplainCommand, args(root, ['handlers-registered']));
        expect(out).toMatch(/^ +declared +2 distinct across 2 file\(s\)/m);
        expect(out).toMatch(/^ +registered +2 distinct across 1 file\(s\)/m);
        // The counts sit beside the verdict line. Its VALUE is not asserted:
        // the lock is on the counts being printed next to it, not on the word.
        expect(out).toMatch(/^ +status +\S+/m);

        const declared = sectionLines(out, 'Declared sites');
        const registered = sectionLines(out, 'Registered sites');
        expect([...declared].sort()).toEqual([
          '  • A_H  (src/handlers/a.ts:1)',
          '  • B_H  (src/handlers/b.ts:1)',
        ]);
        expect([...registered].sort()).toEqual([
          '  • A_H  (src/reg.ts:1)',
          '  • B_H  (src/reg.ts:1)',
        ]);
        for (const line of [...declared, ...registered]) expect(line).toMatch(SITE_LINE);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    IN_PROCESS_TIMEOUT_MS,
  );

  test(
    'a subset rule whose registered set ⊋ declared still PRINTS both disagreeing counts',
    async () => {
      // This is the 1.2 shape. Round 11 changes its verdict; whatever the new
      // verdict says, the two numbers that expose the gap must stay printed.
      const root = explainFixture();
      try {
        const { out } = await run(gatesExplainCommand, args(root, ['handlers-wide']));
        expect(out).toMatch(/^ +declared +2 distinct across 2 file\(s\)/m);
        expect(out).toMatch(/^ +registered +3 distinct across 1 file\(s\)/m);
        const registered = sectionLines(out, 'Registered sites');
        expect(registered).toContain('  • C_H  (src/reg-wide.ts:1)');
        for (const line of registered) expect(line).toMatch(SITE_LINE);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    IN_PROCESS_TIMEOUT_MS,
  );

  test(
    'past 50 sites the text caps with `… (N more)` while --json carries every site',
    async () => {
      const root = cappedFixture();
      try {
        const text = await run(gatesExplainCommand, args(root, ['many-registered']));
        expect(text.out).toMatch(/^ +declared +55 distinct across 1 file\(s\)/m);
        const declared = sectionLines(text.out, 'Declared sites');
        const bullets = declared.filter((l) => SITE_LINE.test(l));
        expect(bullets).toHaveLength(50);
        expect(declared).toContain('  … (5 more)');
        // Each shown site keeps its own file:line — the cap trims the list, it
        // never degrades the lines it keeps.
        for (const b of bullets) {
          const m = SITE_LINE.exec(b)!;
          expect(m[2]).toBe('src/handlers/many.ts');
          expect(m[1]).toBe(`T${String(Number(m[3])).padStart(2, '0')}_H`);
        }
        expect(text.out).not.toContain('T55_H  (src/handlers/many.ts:55)');
        expect(sectionLines(text.out, 'Registered sites')).toContain('  … (5 more)');

        const json = await run(gatesExplainCommand, args(root, ['many-registered'], { json: true }));
        const payload = JSON.parse(json.out) as {
          declared: { distinctCount: number; sites: { token: string; file: string; line: number }[] };
          registered: { distinctCount: number; sites: { token: string; file: string; line: number }[] };
        };
        expect(payload.declared.distinctCount).toBe(55);
        expect(payload.declared.sites).toHaveLength(55);
        expect(payload.registered.sites).toHaveLength(55);
        expect(payload.declared.sites).toContainEqual({ token: 'T55_H', file: 'src/handlers/many.ts', line: 55 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    IN_PROCESS_TIMEOUT_MS,
  );

  test(
    'the unified `shrk explain <ruleId>` prints the SAME body as `shrk gates explain <ruleId>`',
    () => {
      // One entrypoint, one renderer: `explain` forwards a rule id to the gates
      // explainer (tryExplainGateRule). A second rendering path would drift.
      const root = explainFixture();
      try {
        const viaGates = shrk(root, ['gates', 'explain', 'handlers-registered']);
        const viaUnified = shrk(root, ['explain', 'handlers-registered']);
        // Non-vacuous: both must actually carry the extracted set.
        expect(viaGates.stdout).toMatch(/^ +declared +2 distinct across 2 file\(s\)/m);
        expect(viaGates.stdout).toContain('  • A_H  (src/handlers/a.ts:1)');
        expect(viaUnified.stdout).toBe(viaGates.stdout);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'registry-plane explain prints `ids N` plus every id with its sites (text and --json)',
    async () => {
      const root = explainFixture();
      try {
        const text = await run(gatesExplainCommand, args(root, ['handler-ids']));
        expect(text.out).toMatch(/^ +ids +2$/m);
        const idLines = text.out.split('\n').filter((l) => l.startsWith('  • '));
        expect([...idLines].sort()).toEqual([
          '  • A_H  (src/handlers/a.ts:1)',
          '  • B_H  (src/handlers/b.ts:1)',
        ]);

        const json = await run(gatesExplainCommand, args(root, ['handler-ids'], { json: true }));
        const payload = JSON.parse(json.out) as {
          ids: string[];
          sites: { token: string; file: string; line: number }[];
        };
        expect([...payload.ids].sort()).toEqual(['A_H', 'B_H']);
        expect(payload.sites).toContainEqual({ token: 'A_H', file: 'src/handlers/a.ts', line: 1 });
        expect(payload.sites).toContainEqual({ token: 'B_H', file: 'src/handlers/b.ts', line: 1 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    IN_PROCESS_TIMEOUT_MS,
  );
});

/*
 * Spec bullet protected:
 *
 *   "`search tuning explain --json` shows a boost key's applied composition,
 *    which is what proved the 166 doctor warnings in 3.5 were false.
 *    Introspection that contradicts a check is exactly what makes a check
 *    fixable."
 *
 * The inspector-level composition is locked in
 * packages/inspector/src/__tests__/r75-tuning-explain-composition.test.ts;
 * this is the CLI `--format json` surface over the same authority.
 */
describe('r75 do-not-regress — `search tuning explain --format json` composition', () => {
  test(
    'the CLI JSON exposes per-key composition and the `<kind>:<id>` task-hint reason, identical to the library',
    async () => {
      const root = workspace('tuning', {
        'sharkcraft/knowledge.ts': `export const loginFlow = {
  id: 'auth.login-flow',
  title: 'Auth login flow',
  type: 'architecture',
  priority: 'high',
  tags: ['auth', 'login'],
  content: 'How the auth login flow issues a session token after the password check.',
};
`,
        'sharkcraft/search-tuning.ts': `export default [
  { id: 't.one', boostTags: { auth: 3 } },
  {
    id: 't.two',
    boostTags: { auth: 2 },
    taskHints: [{ whenTokens: ['login'], boostIds: { 'knowledge:auth.login-flow': 2 } }],
  },
];
`,
        'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n`,
      });
      try {
        const res = shrk(root, ['search', 'tuning', 'explain', 'auth', 'login', '--format', 'json']);
        const cli = JSON.parse(res.stdout) as {
          topResults: {
            docId: string;
            reasons: string[];
            composition?: { key: string; contributors: { tuningId: string; value: number }[]; combined: number }[];
          }[];
        };
        const hit = cli.topResults.find((r) => r.docId === 'knowledge:auth.login-flow');
        expect(hit).toBeDefined();
        const tag = hit!.composition?.find((c) => c.key === 'tag:auth');
        expect(tag).toBeDefined();
        expect([...tag!.contributors].sort((a, b) => a.tuningId.localeCompare(b.tuningId))).toEqual([
          { tuningId: 't.one', value: 3 },
          { tuningId: 't.two', value: 2 },
        ]);
        expect(tag!.combined).toBe(5);
        expect(hit!.reasons.some((r) => r.includes('task-hint:id:knowledge:auth.login-flow'))).toBe(true);

        // One authority: the CLI prints the library's report, not a re-derivation.
        const inspection = await inspectSharkcraft({ cwd: root });
        const lib = await explainSearchTuning(inspection, 'auth login');
        const libHit = lib.topResults.find((r) => r.docId === 'knowledge:auth.login-flow');
        expect(libHit).toBeDefined();
        expect(hit!.composition as unknown).toEqual(libHit!.composition as unknown);
        expect(hit!.reasons).toEqual([...libHit!.reasons]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

/*
 * Spec bullet protected:
 *
 *   "The `--json` envelope is what made the recommender defect (2.1)
 *    diagnosable rather than merely frustrating — the correct answer was
 *    recoverable because the machine output kept it."
 *
 * Round 11 (2.1) changes the human headline. Only the machine payload's KEYS
 * and the presence of the matched hint are locked — never the headline text.
 */
describe('r75 do-not-regress — `recommend --json` keeps the routing evidence', () => {
  test(
    'a query matching a configured routing hint keeps routingMatches[0].hint.id and non-empty search.sections.bestActions',
    () => {
      const root = workspace('recommend', {
        'sharkcraft/task-routing-hints.ts': `export default [{
  id: 'route.add-payment-webhook',
  title: 'Add a payment webhook handler',
  match: { keywords: ['webhook', 'payment'], phrases: ['payment webhook'] },
  recommends: { commands: ['shrk gen webhook-handler --name <name>'] },
}];
`,
        'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx' };\n`,
      });
      try {
        const res = shrk(root, ['recommend', 'add a payment webhook for stripe', '--json']);
        const payload = JSON.parse(res.stdout) as {
          routingMatches?: { hint: { id: string } }[];
          search?: { sections?: { bestActions?: { id: string }[] } } | null;
        };
        expect(Array.isArray(payload.routingMatches)).toBe(true);
        expect(payload.routingMatches![0]!.hint.id).toBe('route.add-payment-webhook');
        const bestActions = payload.search?.sections?.bestActions;
        expect(Array.isArray(bestActions)).toBe(true);
        expect(bestActions!.length).toBeGreaterThan(0);
        // The correct answer stays recoverable from the machine output.
        expect(bestActions!.some((a) => a.id === 'route.add-payment-webhook')).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});

/*
 * Spec bullets protected:
 *
 *   "Negative-path messages remain actionable where they fire at all: what is
 *    missing, its file:line, and how to fix it."
 *
 *   "The boundary plane's core scan ran clean over a very large import graph
 *    and is the irreplaceable structural win — item 1.5 is about the pattern
 *    language, not the engine, and 6.1(a) is about the extractor, not the
 *    evaluator. The engine itself did its job."
 *
 * The first fixture's forbidden import sits on LINE 1; round 11 fixed the
 * scanner's off-by-one for later lines (every import after line 1 used to be
 * reported one line early), and the line-2 test below now locks the fix.
 */
describe('r75 do-not-regress — `check boundaries` violation block', () => {
  function boundaryFixture(): string {
    return workspace('boundaries', {
      'src/app/page.ts': "import { Button } from '@scope/ui';\nexport const y = Button;\n",
      'sharkcraft/boundaries.ts': `export default [{
  id: 'app-no-ui',
  title: 'App must not import the UI kit directly',
  severity: 'error',
  from: ['src/app/**'],
  forbiddenImports: ['@scope/ui'],
  message: 'App code must go through the facade, not @scope/ui.',
  suggestedFix: 'Import from src/facade/ui instead.',
}];
`,
      'sharkcraft/sharkcraft.config.ts': `export default { boundaryFiles: ['boundaries.ts'] };\n`,
    });
  }

  test(
    'text keeps file:line, the import, the matched pattern, the message and the `↳ <suggestedFix>` line',
    () => {
      const root = boundaryFixture();
      try {
        const res = shrk(root, ['check', 'boundaries']);
        const out = res.stdout;
        expect(out).toContain('src/app/page.ts:1');
        expect(out).toContain('import: "@scope/ui"');
        expect(out).toContain('matched forbidden pattern: @scope/ui');
        expect(out).toContain('App code must go through the facade, not @scope/ui.');
        expect(out).toContain('↳ Import from src/facade/ui instead.');
        // The block reads top-down: location → import → pattern → message → fix.
        const order = [
          'src/app/page.ts:1',
          'import: "@scope/ui"',
          'matched forbidden pattern: @scope/ui',
          'App code must go through the facade, not @scope/ui.',
          '↳ Import from src/facade/ui instead.',
        ].map((s) => out.indexOf(s));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'JSON violations[] keep file, line and importSpecifier',
    () => {
      const root = boundaryFixture();
      try {
        const res = shrk(root, ['check', 'boundaries', '--json']);
        const payload = JSON.parse(res.stdout) as {
          violations: { file: string; line: number; importSpecifier: string }[];
        };
        expect(payload.violations.length).toBeGreaterThan(0);
        const v = payload.violations.find((x) => x.importSpecifier === '@scope/ui');
        expect(v).toBeDefined();
        expect(v!.file).toBe('src/app/page.ts');
        expect(v!.line).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    'an import on line 2 is reported on line 2 — text and JSON (round 11 fixed the off-by-one)',
    () => {
      // The old scanner's `(?:^|\s)` consumed the preceding newline, so every
      // import after line 1 was reported one line early. Now locked.
      const root = workspace('boundaries-l2', {
        'src/app/page.ts': "export const before = 1;\nimport { Button } from '@scope/ui';\nexport const y = Button;\n",
        'sharkcraft/boundaries.ts': `export default [{
  id: 'app-no-ui',
  title: 'App must not import the UI kit directly',
  severity: 'error',
  from: ['src/app/**'],
  forbiddenImports: ['@scope/ui'],
}];
`,
        'sharkcraft/sharkcraft.config.ts': `export default { boundaryFiles: ['boundaries.ts'] };\n`,
      });
      try {
        const text = shrk(root, ['check', 'boundaries']);
        expect(text.stdout).toContain('src/app/page.ts:2');
        expect(text.stdout).not.toContain('src/app/page.ts:1');
        const json = shrk(root, ['check', 'boundaries', '--json']);
        const payload = JSON.parse(json.stdout) as { violations: { file: string; line: number }[] };
        expect(payload.violations.map((v) => `${v.file}:${v.line}`)).toEqual(['src/app/page.ts:2']);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
