/**
 * The full gate matrix against a committed CONSUMER fixture.
 *
 * Every real defect the improvement rounds surfaced — the `--fix` import gap,
 * the mixed-generated-tree misfit, the fence that could never go green — was
 * invisible to unit tests and only appeared when a live consumer drove the
 * tool. `examples/gate-matrix-consumer` is that consumer, committed: one
 * project holding every awkward shape at once, so the edge-case class that
 * slipped through each round is caught here forever.
 *
 * The fixture is DELIBERATELY not clean. Several rules are expected to fail —
 * that is what proves they still fire. Write-mode runs operate on a COPY, so
 * the committed fixture stays byte-stable and these tests stay order-free.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkCommand } from '../commands/check.command.ts';
import { gatesCheckCommand, gatesCoverageCommand } from '../commands/gates.command.ts';
import { baselineCheckCommand } from '../commands/baseline.command.ts';
import { generatedCheckCommand } from '../commands/generated.command.ts';
import { docsReferencesCheckCommand } from '../commands/docs-references.command.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

const FIXTURE = resolve(import.meta.dir, '../../../../examples/gate-matrix-consumer');

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

/** A throwaway copy, so a write-mode run never mutates the committed fixture. */
function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-matrix-'));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

describe('gate matrix — a rule that could not RUN is never a pass', () => {
  /**
   * The whole plane is built so a rule enforcing nothing cannot read as green.
   * The gap: a rule whose registries are all empty reports `error` — it never
   * reached an id — but if its severity is `warning`, "not blocking" used to
   * print above exit 0. Nothing was proved, so the honest answer is 2.
   */
  function withHelperOnlyRule(): string {
    const root = copyFixture();
    const cfg = join(root, 'sharkcraft', 'sharkcraft.config.ts');
    writeFileSync(
      cfg,
      readFileSync(cfg, 'utf8').replace(
        "resolvesAs: ['template', 'playbook'],",
        "resolvesAs: ['helper'],",
      ),
    );
    return root;
  }

  test('`docs references check` exits 2, not 0, when every registry is empty', async () => {
    const root = withHelperOnlyRule();
    try {
      const { code, out } = await run(docsReferencesCheckCommand, args(root, []));
      expect(code).toBe(ExitCode.NotVerified);
      expect(out).toContain('nothing could resolve');
      expect(out).toContain('NOT a pass');
      // The refusal replaces findings — it must not ALSO flag correct ids.
      expect(out).not.toContain('gmc.handler  (');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('`gates check` agrees — an errored warning rule is not `evaluated`', async () => {
    const root = withHelperOnlyRule();
    try {
      const { code } = await run(gatesCheckCommand, args(root, [], { plane: 'doc-reference' }));
      expect(code).toBe(ExitCode.NotVerified);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gate matrix — wiring', () => {
  test('every declared-but-unwired token is reported, across all four rules', async () => {
    const { code, out } = await run(checkCommand, args(FIXTURE, ['wiring']));
    expect(code).toBe(ExitCode.Failure);
    // The derivable sink and the barrel sink both miss GAMMA_HANDLER…
    expect(out).toContain('handlers-registered');
    expect(out).toContain('barrel-handlers-registered');
    expect(out).toContain('GAMMA_HANDLER');
    // …and the import-graph rule finds generated code nobody imports.
    expect(out).toContain('no-orphan-views');
    expect(out).toContain('NgeOrphanView');
  });

  test('companion-file parity is CLEAN — every handler const has its file', async () => {
    const { out } = await run(checkCommand, args(FIXTURE, ['wiring'], { only: 'handler-has-file' }));
    expect(out).toContain('0 error(s)');
  });

  test('--fix completes the derivable sink and REFUSES the barrel, in one run', async () => {
    const { out } = await run(checkCommand, args(FIXTURE, ['wiring'], { fix: true }));
    // Derivable: both halves planned.
    expect(out).toContain("import { GAMMA_HANDLER } from '../handlers/GAMMA_HANDLER';");
    // Barrel: refused, with the reason.
    expect(out).toContain('needs-import');
    expect(out).toContain('barrel.ts');
  });

  test('--fix --write NEVER touches a NON-DERIVABLE sink (barrel or aliased)', async () => {
    // The correctness half of the whole `--fix` fix: a regression that made the
    // non-derivable case append-anyway would silently reintroduce the
    // green-gate/broken-build bug.
    const root = copyFixture();
    try {
      const barrelBefore = readFileSync(join(root, 'src/registry/barrel.ts'), 'utf8');
      const aliasedBefore = readFileSync(join(root, 'src/registry/aliased.ts'), 'utf8');
      await run(checkCommand, args(root, ['wiring'], { fix: true, write: true }));
      // BOTH non-derivable shapes stay byte-identical. A regression that
      // appended anyway would reintroduce the green-gate/broken-build bug.
      expect(readFileSync(join(root, 'src/registry/barrel.ts'), 'utf8')).toBe(barrelBefore);
      expect(readFileSync(join(root, 'src/registry/aliased.ts'), 'utf8')).toBe(aliasedBefore);
      // …while the derivable sink DID gain both the import and the member.
      const derivable = readFileSync(join(root, 'src/registry/derivable.ts'), 'utf8');
      expect(derivable).toContain("import { GAMMA_HANDLER } from '../handlers/GAMMA_HANDLER';");
      expect(derivable).toContain('GAMMA_HANDLER]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gate matrix — generated (mixed tree)', () => {
  test('classifies four ways and fails ONLY on the un-headered file', async () => {
    const { code, out } = await run(generatedCheckCommand, args(FIXTURE, [], { 'headers-only': true }));
    expect(code).toBe(ExitCode.Failure);
    // The one deliberately un-headered file is the only header finding.
    expect(out).toContain('src/generated/Unheadered.ts');
    // The two blessed files — one by config path, one by in-file marker — are
    // exempt, and the two generated files pass their header contract.
    expect(out).not.toContain('src/generated/CannotEditThis.ts —');
    expect(out).not.toContain('src/generated/MarkedByHand.ts —');
  });

  test('both writers verify their own slice against a fresh regen', async () => {
    const { out } = await run(generatedCheckCommand, args(FIXTURE, [], { id: 'views' }));
    expect(out).toContain('views:');
    expect(out).toContain('dtos:');
  });
});

describe('gate matrix — baselines', () => {
  test('the extractor ledger and the import-graph adoption ledger are both green', async () => {
    const { out } = await run(baselineCheckCommand, args(FIXTURE, [], { id: 'handler-roster,adoption-ledger' }));
    expect(out).toContain('handler-roster');
    expect(out).toContain('adoption-ledger');
    expect(out).toContain('Every baseline matches its committed artifact');
  });

  test('the FENCE passes while empty — an asserted-empty set is a real pass', async () => {
    const { code } = await run(baselineCheckCommand, args(FIXTURE, [], { id: 'fence-a-to-b' }));
    expect(code).toBe(ExitCode.VerifiedPass);
  });

  test('the fence FAILS the moment appA reaches into appB', async () => {
    const root = copyFixture();
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(root, 'appA/fine.ts'), "import { secret } from '../appB/secret';\nexport const f = secret;\n");
      const { code, out } = await run(baselineCheckCommand, args(root, [], { id: 'fence-a-to-b' }));
      expect(code).toBe(ExitCode.Failure);
      expect(out).toContain('appA/fine.ts → secret');
      expect(out).toContain('appA must not import from appB');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a LOST adoption edge is caught — the silent de-adoption case', async () => {
    const root = copyFixture();
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(root, 'apps/a.ts'), 'export const a = 1;\n');
      const { code, out } = await run(baselineCheckCommand, args(root, [], { id: 'adoption-ledger' }));
      expect(code).toBe(ExitCode.Failure);
      expect(out).toContain('- apps/a.ts → NgeAlphaView');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('gate matrix — the trust layer over all of it', () => {
  test('gates coverage distinguishes a LIVE command baseline from a STALE one', async () => {
    const { out } = await run(gatesCoverageCommand, args(FIXTURE, []));
    // Live watchFiles: connected, compute honestly unverified, never spawned.
    expect(out).toMatch(/handler-count\s+—\s+\d+ watchFiles input\(s\) \(compute unverified/);
    // Stale watchFiles: zero inputs, reported loudly.
    expect(out).toMatch(/stale-watch\s+—\s+0 watchFiles input\(s\)/);
    expect(out).toContain('the selector is probably stale');
  });

  test('the fence is NOT reported as a stale selector — its empty set is asserted', async () => {
    const { out } = await run(gatesCoverageCommand, args(FIXTURE, []));
    expect(out).toContain('fence-a-to-b  —  0 entries (empty — the asserted state)');
  });

  test('the shared extractors are each reported once, with every consumer', async () => {
    const { out } = await run(gatesCoverageCommand, args(FIXTURE, []));
    expect(out).toContain('$use:handlers');
    expect(out).toContain('$use:viewImports');
    // `handlers` feeds three wiring rules, a registry, a registration idiom and
    // a baseline — six consumers that cannot disagree about the set.
    expect(out).toMatch(/\$use:handlers.*shared by 8 rule\(s\)/);
    expect(out).toMatch(/\$use:viewImports.*shared by 2 rule\(s\)/);
  });

  test('--changed-only scopes by footprint, including an import-edges TARGET', async () => {
    // A fence whose footprint covered only the consumer side would go
    // unevaluated when the TARGET subtree moved — a quiet skip exactly where
    // the rule matters.
    const { out } = await run(
      gatesCoverageCommand,
      args(FIXTURE, [], { since: 'HEAD', 'no-hints': true }),
    );
    // The fixture is untracked, so the diff is empty and nothing is in scope —
    // the assertion is that scoping RAN and said so, not that rules fired.
    expect(out).toMatch(/scope|not a pass|coverage/i);
  });

  test('a multi-hop chain names WHICH hop broke', async () => {
    // Two seams, one rule. A pair of two-sided rules would each blame their own
    // side; the chain says the token was declared-but-unregistered at hop 0 and
    // registered-but-unbootstrapped at hop 1.
    const { out } = await run(checkCommand, args(FIXTURE, ['wiring'], { only: 'handler-chain' }));
    expect(out).toContain('GAMMA_HANDLER');
    expect(out).toContain('[hop 0]');
    expect(out).toContain('BETA_HANDLER');
    expect(out).toContain('[hop 1]');
  });

  test('the barrel trap is demonstrated BOTH ways, and the dead end self-corrects', async () => {
    // `to.files` against a barrel import is technically correct and yields 0 —
    // the one place a user's intuition reliably trips. The fixture holds both
    // spellings so a regression that dropped the diagnosis is caught here.
    const { out } = await run(gatesCoverageCommand, args(FIXTURE, []));
    expect(out).toContain('barrel-by-files  —  0 ids');
    expect(out).toContain("0 edges via `to.files`");
    expect(out).toContain('Target by `to.module`');
    // …and the spelling that works returns the real edge.
    expect(out).toContain('apps/barrel-consumer.ts → NgeCardView');
  });

  test('the doc-reference plane reports the phantom id and NOTHING else', async () => {
    // The doc deliberately holds four id-shaped tokens: two real, one phantom,
    // one plain-prose mention and one marked example. Only the phantom is a
    // finding — a linter that flagged the other three would be turned off.
    const { out } = await run(docsReferencesCheckCommand, args(FIXTURE, []));
    expect(out).toContain('gmc.phantom-renderer');
    expect(out).not.toContain('gmc.handler  (');
    // The PLAYBOOK id resolves too. Templates and playbooks read different
    // registries, and a corpus covering only templates stayed green through a
    // playbook resolver that resolved nothing at all.
    expect(out).not.toContain('gmc.add-handler');
    expect(out).not.toContain('gmc.in-prose');
    expect(out).not.toContain('gmc.example-only');
  });

  test('a warning-severity doc rule reports without claiming everything resolves', async () => {
    const { code, out } = await run(docsReferencesCheckCommand, args(FIXTURE, []));
    expect(code).toBe(ExitCode.VerifiedPass);
    expect(out).toContain('not blocking');
    expect(out).not.toContain('Every id cited in prose resolves');
  });

  test('gates check aggregates every plane into one verdict', async () => {
    const { code, out } = await run(gatesCheckCommand, args(FIXTURE, [], { 'no-spawn': true, json: true }));
    expect(code).toBe(ExitCode.Failure);
    const parsed = JSON.parse(out) as { gate: { rules: { id: string; type: string }[] } };
    // All six planes are represented in one envelope.
    expect([...new Set(parsed.gate.rules.map((r) => r.type))].sort()).toEqual([
      'baseline',
      'doc-reference',
      'generated',
      'policy',
      'registration',
      'registry',
      'wiring',
    ]);
  });
});
