/**
 * Rule drift classification.
 */
import { describe, expect, test } from 'bun:test';
import { KnowledgeType, type IKnowledgeEntry } from '@shrkcrft/knowledge';
import {
  classifyRuleDrift,
  RuleEnforcementState,
} from '../rule-drift.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

function fakeInspection(
  entries: IKnowledgeEntry[],
  configuredVerificationIds: string[] = [],
): ISharkcraftInspection {
  return {
    projectRoot: '/tmp/fake',
    workspace: {} as ISharkcraftInspection['workspace'],
    hasSharkcraftFolder: true,
    sharkcraftDir: '/tmp/fake/sharkcraft',
    config: {
      verificationCommands: configuredVerificationIds.map((id) => ({
        id,
        command: 'echo ok',
      })),
    } as unknown as ISharkcraftInspection['config'],
    configFile: '/tmp/fake/sharkcraft/sharkcraft.config.ts',
    knowledgeEntries: entries,
    templates: [],
    pipelines: [],
    warnings: [],
    sourceFiles: [],
    validationIssues: [],
    packs: {
      discoveredPacks: [],
      validPacks: [],
      invalidPacks: [],
      warnings: [],
    } as unknown as ISharkcraftInspection['packs'],
    entrySources: new Map(),
    templateSources: new Map(),
    pipelineSources: new Map(),
    index: {} as ISharkcraftInspection['index'],
    ruleService: {} as ISharkcraftInspection['ruleService'],
    pathService: {} as ISharkcraftInspection['pathService'],
    templateRegistry: {} as ISharkcraftInspection['templateRegistry'],
    pipelineRegistry: {} as ISharkcraftInspection['pipelineRegistry'],
    presetRegistry: {} as ISharkcraftInspection['presetRegistry'],
    presetSources: new Map(),
    boundaryRegistry: {} as ISharkcraftInspection['boundaryRegistry'],
    boundarySources: new Map(),
    loaderDiagnostics: [],
    inspectionElapsedMs: 0,
    cacheEnabled: false,
    cacheDir: '/tmp/fake/.sharkcraft/cache/inspector/v1',
  };
}

function rule(id: string, overrides: Partial<IKnowledgeEntry> = {}): IKnowledgeEntry {
  return {
    id,
    title: id,
    type: KnowledgeType.Rule,
    priority: 'high',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: '',
    ...overrides,
  } as unknown as IKnowledgeEntry;
}

describe('classifyRuleDrift', () => {
  test('rule with all verifications wired → ENFORCED', () => {
    const r = rule('repo.x', {
      actionHints: { verificationCommands: ['lint', 'test'] },
    } as Partial<IKnowledgeEntry>);
    const report = classifyRuleDrift(fakeInspection([r], ['lint', 'test']));
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.Enforced);
    expect(report.entries[0]?.enforcedVerificationCommands).toEqual(['lint', 'test']);
  });

  test('rule with some verifications wired → PARTIALLY_ENFORCED', () => {
    const r = rule('repo.x', {
      actionHints: { verificationCommands: ['lint', 'test'] },
    } as Partial<IKnowledgeEntry>);
    const report = classifyRuleDrift(fakeInspection([r], ['lint']));
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.PartiallyEnforced);
  });

  test('rule with verifications declared but none wired → PARTIALLY_ENFORCED', () => {
    const r = rule('repo.x', {
      actionHints: { verificationCommands: ['lint'] },
    } as Partial<IKnowledgeEntry>);
    const report = classifyRuleDrift(fakeInspection([r], []));
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.PartiallyEnforced);
    expect(report.entries[0]?.enforcedVerificationCommands).toEqual([]);
  });

  test('rule whose command matches a config command STRING (not id) → ENFORCED', () => {
    // fakeInspection wires every configured id with command 'echo ok'. A rule
    // that declares the runnable command string 'echo ok' (rather than the
    // short config id) must still classify as enforced — this is the field-bug
    // the drift miscount stemmed from (command-string vs config-id mismatch).
    const r = rule('repo.x', {
      actionHints: { verificationCommands: ['echo ok'] },
    } as Partial<IKnowledgeEntry>);
    const report = classifyRuleDrift(fakeInspection([r], ['unit-tests']));
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.Enforced);
    expect(report.entries[0]?.enforcedVerificationCommands).toEqual(['echo ok']);
  });

  test('rule with action hints but no verifications → MANUAL_ONLY', () => {
    const r = rule('repo.x', {
      actionHints: {
        commands: [{ command: 'echo hi' }],
      },
    } as Partial<IKnowledgeEntry>);
    const report = classifyRuleDrift(fakeInspection([r]));
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.ManualOnly);
  });

  test('rule with neither hints nor verifications → ASPIRATIONAL', () => {
    const r = rule('repo.x');
    const report = classifyRuleDrift(fakeInspection([r]));
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.Aspirational);
  });

  test('low-priority no-hint rule is treated as advisory → ASPIRATIONAL', () => {
    const r = rule('repo.x', { priority: 'low' });
    const report = classifyRuleDrift(fakeInspection([r]));
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.Aspirational);
    expect(report.entries[0]?.advisory).toBe(true);
  });

  test('validation-issue match → STALE', () => {
    const r = rule('repo.x', {
      actionHints: { verificationCommands: ['lint'] },
    } as Partial<IKnowledgeEntry>);
    const inspection = fakeInspection([r], ['lint']);
    (inspection.validationIssues as unknown as Array<unknown>).push({
      entryId: 'repo.x',
      severity: 'error',
      message: 'missing referenced symbol Foo',
    });
    const report = classifyRuleDrift(inspection);
    expect(report.entries[0]?.state).toBe(RuleEnforcementState.Stale);
  });

  test('summary counts every state bucket', () => {
    const report = classifyRuleDrift(
      fakeInspection(
        [
          rule('a', {
            actionHints: { verificationCommands: ['lint'] },
          } as Partial<IKnowledgeEntry>),
          rule('b'),
          rule('c', {
            actionHints: { commands: [{ command: 'x' }] },
          } as Partial<IKnowledgeEntry>),
        ],
        ['lint'],
      ),
    );
    expect(report.summary[RuleEnforcementState.Enforced]).toBe(1);
    expect(report.summary[RuleEnforcementState.Aspirational]).toBe(1);
    expect(report.summary[RuleEnforcementState.ManualOnly]).toBe(1);
  });

  test('non-rule knowledge entries are excluded from the report', () => {
    const note = {
      id: 'note.x',
      title: 'note',
      type: KnowledgeType.Technical,
      priority: 'low',
      scope: [],
      tags: [],
      appliesWhen: [],
      content: '',
    } as unknown as IKnowledgeEntry;
    const report = classifyRuleDrift(fakeInspection([note]));
    expect(report.entries.length).toBe(0);
  });
});
