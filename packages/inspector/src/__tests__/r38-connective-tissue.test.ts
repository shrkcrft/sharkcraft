/**
 * Connective tissue / self-policing tests.
 *
 *   1. self-config doctor v2 surfaces broken helper IDs in agent-tests.
 *   2. doctor acknowledgements reject empty / TODO reasons and missing expiry.
 *   3. parseExpiresIn parses 7d / 48h / 2w / 30m correctly.
 *   4. import hygiene allowlist draft generator includes TODO placeholder.
 *   5. strict allowlist mode rejects TODO-reason entries.
 *   6. apply dispatch trace classifies synthetic templateIds correctly.
 *   7. pack contribution inventory v2 dedupes structural+regex via (kind,pkg,id).
 *   8. changed-preflight planner picks gates from changed-file shape.
 *   9. entrypoint matrix lists the four classes.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import {
  buildAcknowledgement,
  parseExpiresIn,
  summarizeAcknowledgements,
} from '../doctor-acknowledgements.ts';
import {
  buildApplyDispatchTrace,
  DispatchKind,
} from '../apply-dispatch-trace.ts';
import {
  buildImportHygieneReport,
  emitImportHygieneAllowlistDraft,
  ImportHygieneFindingKind,
  isTodoReason,
} from '../import-hygiene.ts';
import {
  planChangedPreflight,
  PreflightAction,
  PreflightProfile,
} from '../changed-preflight.ts';
import {
  buildEntrypointMatrix,
  EntrypointClass,
} from '../entrypoint-matrix.ts';
import type { ISavedPlan } from '@shrkcrft/generator';

function mkProject(): string {
  return mkdtempSync(nodePath.join(tmpdir(), 'shrk-r38-'));
}

describe('doctor acknowledgements', () => {
  it('rejects empty reason', () => {
    const r = buildAcknowledgement({
      category: 'demo',
      reason: '',
      expiresIn: '7d',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('reason is required');
  });

  it('rejects TODO-prefixed reason', () => {
    const r = buildAcknowledgement({
      category: 'demo',
      reason: 'TODO: figure out later',
      expiresIn: '7d',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('TODO');
  });

  it('rejects missing expiry', () => {
    const r = buildAcknowledgement({
      category: 'demo',
      reason: 'investigating; reopen in a week',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('--expires-at or --expires-in');
  });

  it('rejects expiry in the past', () => {
    const r = buildAcknowledgement({
      category: 'demo',
      reason: 'historical entry',
      expiresAt: '2000-01-01T00:00:00Z',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('already in the past');
  });

  it('accepts a well-formed acknowledgement', () => {
    const now = new Date('2026-05-15T00:00:00Z');
    const r = buildAcknowledgement({
      category: 'demo',
      reason: 'investigating; reopen in a week',
      expiresIn: '7d',
      now,
    });
    expect(r.ok).toBe(true);
    expect(r.entry?.reason).toBe('investigating; reopen in a week');
    expect(r.entry?.expiresAt).toMatch(/^2026-05-22T/);
  });

  it('parseExpiresIn handles d / h / w / m units', () => {
    const now = new Date('2026-05-15T00:00:00Z');
    expect(parseExpiresIn('7d', now)).toBe('2026-05-22T00:00:00.000Z');
    expect(parseExpiresIn('48h', now)).toBe('2026-05-17T00:00:00.000Z');
    expect(parseExpiresIn('2w', now)).toBe('2026-05-29T00:00:00.000Z');
    expect(parseExpiresIn('30m', now)).toBe('2026-05-15T00:30:00.000Z');
    expect(parseExpiresIn('garbage', now)).toBeNull();
  });

  it('summarizeAcknowledgements buckets entries by state', () => {
    const now = new Date('2026-05-15T00:00:00Z');
    const summary = summarizeAcknowledgements(
      [
        { reason: 'live', expiresAt: '2026-12-31T00:00:00Z' },
        { reason: 'soon', expiresAt: '2026-05-16T00:00:00Z' },
        { reason: 'expired', expiresAt: '2025-01-01T00:00:00Z' },
        { reason: 'bare suppression' },
      ],
      { now, expiringSoonDays: 7 },
    );
    expect(summary.acknowledgements.length).toBe(2);
    expect(summary.expiringSoon.length).toBe(1);
    expect(summary.expired.length).toBe(1);
    expect(summary.bareSuppressions.length).toBe(1);
  });
});

describe('import hygiene allowlist draft', () => {
  it('emits an entry per file with TODO placeholder', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `export async function load() {\n  const m = await import('./b');\n  return m;\n}\n`,
      'utf8',
    );
    const report = buildImportHygieneReport(root, { skipAllowlist: true });
    const draft = emitImportHygieneAllowlistDraft(report);
    expect(draft.allow.length).toBeGreaterThanOrEqual(1);
    expect(draft.allow[0]?.reason.startsWith('TODO:')).toBe(true);
    expect(draft.allow[0]?.kind).toBe(ImportHygieneFindingKind.DynamicImport);
  });

  it('isTodoReason recognises empty / TODO strings', () => {
    expect(isTodoReason('')).toBe(true);
    expect(isTodoReason('   ')).toBe(true);
    expect(isTodoReason('TODO: explain')).toBe(true);
    expect(isTodoReason('todo: ditto')).toBe(true);
    expect(isTodoReason('Lazy load — CLI subcommand boundary.')).toBe(false);
  });

  it('strict mode keeps the warning when the allowlist reason is TODO', () => {
    const root = mkProject();
    const pkg = nodePath.join(root, 'packages', 'demo', 'src');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      nodePath.join(pkg, 'a.ts'),
      `export async function load() {\n  const m = await import('./b');\n  return m;\n}\n`,
      'utf8',
    );
    const allowlist = nodePath.join(root, 'sharkcraft', 'import-hygiene.allowlist.json');
    mkdirSync(nodePath.dirname(allowlist), { recursive: true });
    writeFileSync(
      allowlist,
      JSON.stringify(
        {
          schema: 'sharkcraft.import-hygiene-allowlist/v1',
          allow: [
            {
              path: 'packages/demo/src/a.ts',
              kind: 'dynamic-import',
              reason: 'TODO: explain why this dynamic-import is intentional',
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );
    // Non-strict mode: the entry suppresses the warning.
    const r1 = buildImportHygieneReport(root);
    const w1 = r1.findings.filter(
      (f) => f.kind === ImportHygieneFindingKind.DynamicImport && f.severity === 'warning',
    );
    expect(w1.length).toBe(0);
    // Strict mode: the same entry does NOT suppress.
    const r2 = buildImportHygieneReport(root, { strictAllowlistReasons: true });
    const w2 = r2.findings.filter(
      (f) => f.kind === ImportHygieneFindingKind.DynamicImport && f.severity === 'warning',
    );
    expect(w2.length).toBeGreaterThanOrEqual(1);
  });
});

describe('apply dispatch trace', () => {
  function syntheticPlan(templateId: string): ISavedPlan {
    return {
      schema: 'sharkcraft.plan/v1',
      templateId,
      variables: {},
      projectRoot: '/tmp/r38',
      createdAt: '2026-05-15T00:00:00Z',
      expectedChanges: [],
    } as unknown as ISavedPlan;
  }
  const stubInspection = {
    projectRoot: '/tmp/r38',
    templateRegistry: { get: (_: string) => undefined, list: () => [] },
  } as unknown as Parameters<typeof buildApplyDispatchTrace>[0]['inspection'];

  it('classifies __helper__ as helper dispatch', () => {
    const trace = buildApplyDispatchTrace({
      plan: syntheticPlan('__helper__core.add-plugin-key'),
      inspection: stubInspection,
    });
    expect(trace.dispatchKind).toBe(DispatchKind.Helper);
    expect(trace.synthetic).toBe(true);
    expect(trace.handler).toContain('helper-registry');
  });

  it('classifies __registration-hint__ as registration-hint dispatch', () => {
    const trace = buildApplyDispatchTrace({
      plan: syntheticPlan('__registration-hint__route'),
      inspection: stubInspection,
    });
    expect(trace.dispatchKind).toBe(DispatchKind.RegistrationHint);
  });

  it('marks unknown template as blocked', () => {
    const trace = buildApplyDispatchTrace({
      plan: syntheticPlan('engine.cli-command'),
      inspection: stubInspection,
    });
    expect(trace.dispatchKind).toBe(DispatchKind.Unknown);
    expect(trace.finalAction).toBe('blocked');
    expect(trace.blockReasons.some((r) => r.includes('not registered'))).toBe(true);
  });

  it('surfaces folder-op safety flags as requires-flag', () => {
    const plan = {
      schema: 'sharkcraft.plan/v1',
      templateId: '__plugin-lifecycle__rename',
      variables: {},
      projectRoot: '/tmp/r38',
      createdAt: '2026-05-15T00:00:00Z',
      folderOps: [
        { kind: 'rename-folder', targetPath: 'libs/old', newPath: 'libs/new' },
        { kind: 'delete-folder', targetPath: 'libs/cruft' },
      ],
    } as unknown as ISavedPlan;
    const trace = buildApplyDispatchTrace({
      plan,
      inspection: stubInspection,
    });
    expect(trace.totalFolderOps).toBe(2);
    expect(trace.requiredFlags).toContain('--allow-folder-ops');
    expect(trace.requiredFlags).toContain('--allow-delete-folder');
  });
});

describe('changed-preflight planner', () => {
  it('runs boundaries + imports + typecheck when engine src changes', () => {
    const plan = planChangedPreflight({
      projectRoot: '/tmp/r38',
      changedFiles: ['packages/inspector/src/foo.ts'],
      profile: PreflightProfile.Standard,
    });
    const ran = plan.gates.filter((g) => g.action === PreflightAction.Run).map((g) => g.id);
    expect(ran).toContain('boundaries');
    expect(ran).toContain('imports');
    expect(ran).toContain('typecheck');
  });

  it('skips template-drift when no template / pack changes', () => {
    const plan = planChangedPreflight({
      projectRoot: '/tmp/r38',
      changedFiles: ['docs/overview.md'],
      profile: PreflightProfile.Standard,
    });
    const drift = plan.gates.find((g) => g.id === 'templates-drift');
    expect(drift?.action).toBe(PreflightAction.Skip);
    expect(drift?.reason).toContain('no template');
  });

  it('runs self-config-doctor when sharkcraft/ changes', () => {
    const plan = planChangedPreflight({
      projectRoot: '/tmp/r38',
      changedFiles: ['sharkcraft/rules.ts'],
      profile: PreflightProfile.Standard,
    });
    const doctor = plan.gates.find((g) => g.id === 'self-config-doctor');
    expect(doctor?.action).toBe(PreflightAction.Run);
  });

  it('strict profile runs safety audit even without safety-area changes', () => {
    const plan = planChangedPreflight({
      projectRoot: '/tmp/r38',
      changedFiles: ['packages/inspector/src/foo.ts'],
      profile: PreflightProfile.Strict,
    });
    const safety = plan.gates.find((g) => g.id === 'safety-audit-deep');
    expect(safety?.action).toBe(PreflightAction.Run);
    const tests = plan.gates.find((g) => g.id === 'tests');
    expect(tests?.action).toBe(PreflightAction.Run);
  });
});

describe('entrypoint matrix', () => {
  it('exposes the four classes', () => {
    const report = buildEntrypointMatrix();
    const classes = new Set(report.entries.map((e) => e.class));
    expect(classes.has(EntrypointClass.HumanInteractive)).toBe(true);
    expect(classes.has(EntrypointClass.AgentMcp)).toBe(true);
    expect(classes.has(EntrypointClass.MachineJson)).toBe(true);
    expect(classes.has(EntrypointClass.DebugExplainability)).toBe(true);
  });

  it('mentions shrk recommend as the primary human entrypoint', () => {
    const report = buildEntrypointMatrix();
    const recommend = report.entries.find((e) => e.id === 'recommend');
    expect(recommend?.class).toBe(EntrypointClass.HumanInteractive);
    expect(report.decisionTree[0]?.use).toContain('recommend');
  });
});

