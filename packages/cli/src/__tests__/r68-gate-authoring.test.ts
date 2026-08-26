/**
 * The round-2 gate-authoring surfaces: shared `extractors` (`$use`), the
 * aggregate `gates check`, `--changed-only` scoping, the `command`-baseline
 * `watchFiles` probe, and the `gates try` rule REPL.
 *
 * The bugs this file exists to prevent, in order:
 *   • three planes describing "the same set" via three copied selectors, one of
 *     which quietly drifts;
 *   • an aggregate gate that reports a clean pass while a plane never ran;
 *   • a mistyped flag reading as a satisfied opt-in at exit 0.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatesCheckCommand,
  gatesCoverageCommand,
  gatesExplainCommand,
  gatesTryCommand,
} from '../commands/gates.command.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

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

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs) {
  const restore = capture();
  try {
    const code = await h.run(a);
    return { code, out: restore() };
  } catch (e) {
    restore();
    throw e;
  }
}

/** A workspace whose wiring rule, registry, and baseline share ONE extractor. */
function sharedExtractorFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r68-'));
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  mkdirSync(join(root, 'src', 'handlers'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(
    join(root, 'src', 'handlers', 'a.ts'),
    'export const ALPHA_HANDLER = 1;\nexport const BETA_HANDLER = 2;\nexport const notAHandler = 3;\n',
  );
  writeFileSync(join(root, 'src', 'registry.ts'), 'export const HANDLERS = [ALPHA_HANDLER, BETA_HANDLER];\n');
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default {
  extractors: {
    handlers: { files: ['src/handlers/*.ts'], extract: 'export-names', match: '_HANDLER$' },
  },
  wiringRules: [{
    id: 'handlers-registered',
    declared: { $use: 'handlers' },
    registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
  }],
  registries: [{ name: 'handlers', source: { $use: 'handlers' } }],
};
`,
  );
  return root;
}

describe('shared extractors — one definition, N consumers', () => {
  test('coverage reports the shared extractor ONCE, naming every consumer', async () => {
    const root = sharedExtractorFixture();
    try {
      const { code, out } = await run(gatesCoverageCommand, args(root, []));
      expect(code).toBe(ExitCode.VerifiedPass);
      expect(out).toContain('shared extractors');
      // One line for the extractor itself...
      expect(out.match(/\$use:handlers {2}—/g) ?? []).toHaveLength(1);
      // ...listing both consumers, so "are these two rules checking the same
      // set?" is answerable without opening the config.
      expect(out).toContain('wiring:handlers-registered');
      expect(out).toContain('registry:handlers');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a consumer bound through a NON-primary side is still listed', async () => {
    // The regression: coverage inspects a wiring rule's `declared` side, so a
    // rule sharing the extractor on its `registered` sink was silently missing
    // from the consumer list — understating exactly the guarantee being made.
    const root = mkdtempSync(join(tmpdir(), 'shrk-r68d-'));
    try {
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
      writeFileSync(join(root, 'src', 'h.ts'), 'export const A_HANDLER = 1;\n');
      writeFileSync(join(root, 'src', 'registry.ts'), 'export const HANDLERS = [A_HANDLER];\n');
      writeFileSync(
        join(root, 'sharkcraft', 'sharkcraft.config.ts'),
        `export default {
  extractors: {
    sink: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
  },
  wiringRules: [{
    id: 'w',
    declared: { files: ['src/h.ts'], extract: 'export-names', match: '_HANDLER$' },
    registered: { $use: 'sink' },
  }],
  baselines: [{
    id: 'b', baseline: 'sharkcraft/roster.txt',
    compute: { kind: 'extractor', source: { $use: 'sink' } },
  }],
};
`,
      );
      const { out } = await run(gatesCoverageCommand, args(root, []));
      expect(out).toContain('shared by 2 rule(s)');
      expect(out).toContain('wiring:w');
      expect(out).toContain('baseline:b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('each consumer is labelled with the extractor it resolved from', async () => {
    const root = sharedExtractorFixture();
    try {
      const { out } = await run(gatesCoverageCommand, args(root, []));
      expect(out).toContain('[wiring] handlers-registered (via $use:handlers)');
      expect(out).toContain('[registry] handlers (via $use:handlers)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a typo\'d $use fails the LOAD — it never degrades to matching nothing', async () => {
    const root = sharedExtractorFixture();
    try {
      const cfg = join(root, 'sharkcraft', 'sharkcraft.config.ts');
      writeFileSync(
        cfg,
        `export default {
  extractors: { handlers: { files: ['src/handlers/*.ts'], extract: 'export-names' } },
  registries: [{ name: 'handlers', source: { $use: 'handlerz' } }],
};
`,
      );
      const { code, out } = await run(gatesCoverageCommand, args(root, []));
      expect(code).toBe(ExitCode.UsageError);
      expect(out).toContain('unknown extractor "handlerz"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('explain names the shared extractor on EVERY consumer', async () => {
    const root = sharedExtractorFixture();
    try {
      const { out } = await run(gatesExplainCommand, args(root, ['handlers-registered']));
      expect(out).toContain('(via $use:handlers)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gates check — one command, every plane, one exit code', () => {
  test('runs every declared plane and passes when all are clean', async () => {
    const root = sharedExtractorFixture();
    try {
      const { code, out } = await run(gatesCheckCommand, args(root, []));
      expect(code).toBe(ExitCode.VerifiedPass);
      expect(out).toContain('[wiring] handlers-registered');
      expect(out).toContain('[registry] handlers');
      expect(out).toContain('Every declared rule ran and passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a violation on ANY plane fails the aggregate', async () => {
    const root = sharedExtractorFixture();
    try {
      // Drop BETA_HANDLER from the sink: declared-but-not-registered.
      writeFileSync(join(root, 'src', 'registry.ts'), 'export const HANDLERS = [ALPHA_HANDLER];\n');
      const { code, out } = await run(gatesCheckCommand, args(root, []));
      expect(code).toBe(ExitCode.Failure);
      expect(out).toContain('BETA_HANDLER');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the shared JSON envelope carries every plane under one `gate` key', async () => {
    const root = sharedExtractorFixture();
    try {
      const { out } = await run(gatesCheckCommand, args(root, [], { json: true }));
      const parsed = JSON.parse(out) as {
        gate: { verb: string; rules: { id: string; type: string; status: string }[]; evaluated: number };
      };
      expect(parsed.gate.verb).toBe('gates check');
      expect(parsed.gate.rules.map((r) => r.type).sort()).toEqual(['registry', 'wiring']);
      expect(parsed.gate.evaluated).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a warning-severity finding does not block, but the banner still says it fired', async () => {
    // "Everything passed" printed next to a violation is the half-truth that
    // trains people to stop reading gate output.
    const root = mkdtempSync(join(tmpdir(), 'shrk-r68e-'));
    try {
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
      writeFileSync(join(root, 'src', 'a.ts'), "export const S = inject('svc');\n");
      writeFileSync(
        join(root, 'sharkcraft', 'sharkcraft.config.ts'),
        `export default {
  registrationGraph: [{
    name: 'di',
    declared: { files: ['src/*.ts'], extract: 'call-args', anchor: 'inject' },
    provided: { files: ['src/*.ts'], extract: 'call-args', anchor: 'provide' },
    consumed: { files: ['src/*.ts'], extract: 'call-args', anchor: 'inject' },
  }],
};
`,
      );
      const { code, out } = await run(gatesCheckCommand, args(root, []));
      expect(code).toBe(ExitCode.VerifiedPass);
      expect(out).toContain('warning rule(s) reported findings');
      expect(out).not.toContain('Every declared rule ran and passed');
      expect(out).toContain('svc');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an unknown --only id is REFUSED, never narrowed to a silent empty pass', async () => {
    const root = sharedExtractorFixture();
    try {
      const { code, out } = await run(gatesCheckCommand, args(root, [], { only: 'nope' }));
      expect(code).toBe(ExitCode.UsageError);
      expect(out).toContain('Unknown rule id(s) in --only: nope');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a mistyped flag is rejected rather than read as an opt-in at exit 0', async () => {
    const root = sharedExtractorFixture();
    try {
      const { code, out } = await run(gatesCheckCommand, args(root, [], { 'chnged-only': true }));
      expect(code).toBe(ExitCode.UsageError);
      expect(out).toContain('Unknown flag "--chnged-only"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gates try — dry-run a rule before it exists in config', () => {
  test('resolves both sides of an inline wiring spec and never writes config', async () => {
    const root = sharedExtractorFixture();
    try {
      const { out } = await run(
        gatesTryCommand,
        args(root, [], {
          wiring: 'declared=src/handlers/*.ts:export const (\\w+_HANDLER) registered=src/registry.ts:(\\w+_HANDLER)',
        }),
      );
      expect(out).toContain('declared');
      expect(out).toContain('registered');
      expect(out).toContain('Nothing was written');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a candidate whose selector matches nothing is NOT-VERIFIED, not a pass', async () => {
    const root = sharedExtractorFixture();
    try {
      const { code } = await run(
        gatesTryCommand,
        args(root, [], {
          wiring: 'declared=src/nope/*.ts:(\\w+) registered=src/registry.ts:(\\w+_HANDLER)',
        }),
      );
      expect(code).toBe(ExitCode.NotVerified);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a candidate rule-file is validated with the loader\'s own schema', async () => {
    const root = sharedExtractorFixture();
    try {
      const file = join(root, 'candidate.json');
      // `source` names no extraction mode — the loader's exact complaint.
      writeFileSync(file, JSON.stringify({ name: 'x', source: { files: ['src/**/*.ts'] } }));
      const { code, out } = await run(gatesTryCommand, args(root, [], { 'rule-file': file }));
      expect(code).toBe(ExitCode.UsageError);
      expect(out).toContain('sets no extraction mode');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a candidate may $use the project\'s shared extractors', async () => {
    const root = sharedExtractorFixture();
    try {
      const file = join(root, 'candidate.json');
      writeFileSync(file, JSON.stringify({ name: 'candidate', source: { $use: 'handlers' } }));
      const { code, out } = await run(gatesTryCommand, args(root, [], { 'rule-file': file }));
      expect(code).toBe(ExitCode.VerifiedPass);
      expect(out).toContain('via extractor');
      expect(out).toContain('ALPHA_HANDLER');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('command-baseline watchFiles probe', () => {
  /** A repo whose only rule is a `command` baseline — the trust-layer blind spot. */
  function commandBaselineFixture(watchFiles: string): string {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r68b-'));
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'sharkcraft', 'ledger.txt'), 'a\n');
    writeFileSync(
      join(root, 'sharkcraft', 'sharkcraft.config.ts'),
      `export default {
  baselines: [{
    id: 'ledger',
    baseline: 'sharkcraft/ledger.txt',
    compute: { kind: 'command', run: 'echo a' },
    watchFiles: ${watchFiles},
  }],
};
`,
    );
    return root;
  }

  test('live watchFiles report the rule as connected WITHOUT spawning the command', async () => {
    const root = commandBaselineFixture(`['src/*.ts']`);
    try {
      const { code, out } = await run(gatesCoverageCommand, args(root, []));
      expect(out).toContain('watchFiles input(s)');
      expect(out).toContain('compute unverified — command never run');
      expect(code).toBe(ExitCode.VerifiedPass);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the command is PROVABLY not spawned — its side effect never happens', async () => {
    // The claim "never run" has to be verified, not just printed. A compute
    // whose command would leave a sentinel behind turns the claim into a fact:
    // if coverage ever started spawning, this file would appear.
    const root = mkdtempSync(join(tmpdir(), 'shrk-r68spawn-'));
    try {
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'sharkcraft', 'ledger.txt'), 'a\n');
      writeFileSync(
        join(root, 'sharkcraft', 'sharkcraft.config.ts'),
        `export default {
  baselines: [{
    id: 'ledger',
    baseline: 'sharkcraft/ledger.txt',
    compute: { kind: 'command', run: 'echo spawned > SPAWNED.txt' },
    watchFiles: ['src/*.ts'],
  }],
};
`,
      );
      const sentinel = join(root, 'SPAWNED.txt');
      expect(existsSync(sentinel)).toBe(false);
      await run(gatesCoverageCommand, args(root, []));
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('watchFiles pointing at a moved dir is caught as an empty match', async () => {
    const root = commandBaselineFixture(`['moved/*.ts']`);
    try {
      const { code, out } = await run(gatesCoverageCommand, args(root, []));
      // The whole point: a stale command baseline is now distinguishable from a
      // healthy one, which "not inspected" made impossible.
      expect(out).toContain('matched nothing');
      expect(code).not.toBe(ExitCode.VerifiedPass);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('with no watchFiles the report stays honest about not having checked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-r68c-'));
    try {
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
      writeFileSync(join(root, 'sharkcraft', 'ledger.txt'), 'a\n');
      writeFileSync(
        join(root, 'sharkcraft', 'sharkcraft.config.ts'),
        `export default {
  baselines: [{ id: 'ledger', baseline: 'sharkcraft/ledger.txt', compute: { kind: 'command', run: 'echo a' } }],
};
`,
      );
      const { out } = await run(gatesCoverageCommand, args(root, []));
      expect(out).toContain('not inspected');
      expect(out).toContain('add `watchFiles` to enable the probe');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
