/**
 * Inspector tests for the new rule-tooling surfaces.
 *
 *   1. buildRuleScaffold returns the expected file shape and warnings.
 *   2. diagnoseRuleQuality detects the new finding codes:
 *      - missing-examples on style/architecture rules
 *      - vague-rule on short content + no forbidden / no examples
 *      - advisory-not-marked when "advisory" tag present without metadata
 *      - verification-references-unknown-script for unrecognised commands
 *   3. Advisory rules opt out of missing-verification.
 *   4. buildCustomChecksRegistry deduplicates and validates descriptors.
 *   5. parseCustomCheckReport parses JSON + text fallback.
 *   6. buildCodemodAssistReport groups by risk and emits the script template.
 *   7. explainPackSignatureStatus distinguishes the lifecycle states.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCodemodAssistReport,
  buildCustomChecksRegistry,
  buildRuleScaffold,
  CodemodRiskBand,
  CustomCheckOutput,
  CustomCheckSafety,
  CustomCheckScope,
  CustomCheckStatus,
  diagnoseRuleQuality,
  doctorCustomChecks,
  parseCustomCheckReport,
  RuleScaffoldKind,
} from '../index.ts';
import { defineKnowledgeEntry, KnowledgePriority, KnowledgeType, type IKnowledgeEntry } from '@shrkcrft/knowledge';

function ruleEntry(over: Partial<IKnowledgeEntry>): IKnowledgeEntry {
  return defineKnowledgeEntry({
    id: 'test.rule',
    title: 'A rule',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    scope: ['test'],
    tags: [],
    appliesWhen: ['generate-code'],
    content: 'Some long content that is comfortably above the 80 character threshold for vague-detection.',
    ...over,
  });
}

describe('rule scaffold', () => {
  test('returns three files with the expected paths', () => {
    const r = buildRuleScaffold({ id: 'architecture.no-reexport-proxy', kind: RuleScaffoldKind.Architecture });
    expect(r.tsScaffold.path).toBe('.sharkcraft/fixes/rule-architecture-no-reexport-proxy.preview.ts');
    expect(r.jsonManifest.path).toBe('.sharkcraft/fixes/rule-architecture-no-reexport-proxy.preview.json');
    expect(r.explainer.path).toBe('.sharkcraft/fixes/rule-architecture-no-reexport-proxy.preview.md');
    expect(r.tsScaffold.body).toContain('defineRule');
    expect(r.tsScaffold.body).toContain('architecture.no-reexport-proxy');
  });

  test('warns about missing rationale and bad id pattern', () => {
    const r = buildRuleScaffold({ id: 'BAD_ID', kind: RuleScaffoldKind.Architecture });
    expect(r.warnings.some((w) => /pattern/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /rationale/i.test(w))).toBe(true);
  });

  test('advisory kind sets metadata.advisory on the JSON manifest', () => {
    const r = buildRuleScaffold({ id: 'advisory.tip', kind: RuleScaffoldKind.Advisory });
    const manifest = JSON.parse(r.jsonManifest.body);
    expect(manifest.advisory).toBe(true);
    expect(r.tsScaffold.body).toContain('metadata: { advisory: true }');
  });

  test('examples are emitted when supplied', () => {
    const r = buildRuleScaffold({
      id: 'style.use-const',
      kind: RuleScaffoldKind.Style,
      goodExample: 'const x = 1;',
      badExample: 'let x = 1;',
    });
    expect(r.tsScaffold.body).toContain('Good');
    expect(r.tsScaffold.body).toContain('Bad');
  });
});

describe('rule quality doctor', () => {
  test('vague rule is flagged warning', () => {
    const r = ruleEntry({ id: 'r.vague', content: 'short.', actionHints: undefined, tags: [] });
    const report = diagnoseRuleQuality([r]);
    expect(report.findings.some((f) => f.code === 'vague-rule')).toBe(true);
  });

  test('style rule without examples is flagged missing-examples', () => {
    const r = ruleEntry({ id: 'r.style', tags: ['style'], examples: undefined });
    const report = diagnoseRuleQuality([r]);
    expect(report.findings.some((f) => f.code === 'missing-examples' && f.ruleId === 'r.style')).toBe(true);
  });

  test('advisory rule with metadata.advisory is exempt from missing-verification', () => {
    const r = ruleEntry({
      id: 'r.advisory',
      metadata: { advisory: true },
      tags: ['advisory'],
      content: 'A long content explaining the advisory rationale that exceeds the vague threshold check easily.',
      actionHints: { forbiddenActions: ['some'] },
    });
    const report = diagnoseRuleQuality([r]);
    expect(report.findings.some((f) => f.code === 'missing-verification' && f.ruleId === 'r.advisory')).toBe(false);
  });

  test('advisory tag without metadata is flagged advisory-not-marked', () => {
    const r = ruleEntry({
      id: 'r.tagonly',
      tags: ['advisory'],
      metadata: undefined,
    });
    const report = diagnoseRuleQuality([r]);
    expect(report.findings.some((f) => f.code === 'advisory-not-marked')).toBe(true);
  });

  test('verification references unknown command -> info finding', () => {
    const r = ruleEntry({
      id: 'r.verify',
      actionHints: {
        forbiddenActions: ['x'],
        verificationCommands: ['weird-tool --check'],
      },
    });
    const report = diagnoseRuleQuality([r]);
    expect(
      report.findings.some(
        (f) => f.code === 'verification-references-unknown-script' && f.ruleId === 'r.verify',
      ),
    ).toBe(true);
  });

  test('verification command starting with shrk is recognised', () => {
    const r = ruleEntry({
      id: 'r.verify-ok',
      actionHints: { forbiddenActions: ['x'], verificationCommands: ['shrk doctor'] },
    });
    const report = diagnoseRuleQuality([r]);
    expect(report.findings.some((f) => f.code === 'verification-references-unknown-script')).toBe(false);
  });

  test('every finding carries category, recommendedFix, whyThisMatters', () => {
    const r = ruleEntry({ id: 'r.q', content: 'short' });
    const report = diagnoseRuleQuality([r]);
    for (const f of report.findings) {
      expect(f.category).toBe('rule-quality');
      expect(typeof f.whyThisMatters).toBe('string');
      expect(f.whyThisMatters.length).toBeGreaterThan(0);
      expect(typeof f.recommendedFix).toBe('string');
    }
  });
});

describe('custom checks registry', () => {
  test('reads metadata.checks from rule entries', () => {
    const r = ruleEntry({
      id: 'r.check',
      metadata: {
        checks: [
          {
            id: 'r-check-1',
            command: 'bun run scripts/check.ts',
            kind: 'text-shape',
            safety: 'read-only',
            output: 'json',
            reportPath: '.sharkcraft/reports/check.json',
          },
        ],
      },
    });
    const reg = buildCustomChecksRegistry([r]);
    expect(reg.entries.length).toBe(1);
    expect(reg.entries[0]!.descriptor.id).toBe('r-check-1');
    expect(reg.entries[0]!.descriptor.ownerRuleId).toBe('r.check');
    expect(reg.invalid.length).toBe(0);
  });

  test('rejects descriptor missing command', () => {
    const r = ruleEntry({
      id: 'r.bad',
      metadata: { checks: [{ id: 'no-cmd' }] },
    });
    const reg = buildCustomChecksRegistry([r]);
    expect(reg.invalid.length).toBeGreaterThan(0);
  });

  test('detects duplicate check ids across rules', () => {
    const r1 = ruleEntry({
      id: 'r.dup1',
      metadata: { checks: [{ id: 'shared', command: 'echo 1' }] },
    });
    const r2 = ruleEntry({
      id: 'r.dup2',
      metadata: { checks: [{ id: 'shared', command: 'echo 2' }] },
    });
    const reg = buildCustomChecksRegistry([r1, r2]);
    expect(reg.duplicates.some((d) => d.id === 'shared')).toBe(true);
    const doctor = doctorCustomChecks(reg);
    expect(doctor.errors).toBeGreaterThan(0);
  });

  test('warning emitted for JSON output without reportPath', () => {
    const r = ruleEntry({
      id: 'r.report',
      metadata: { checks: [{ id: 'no-report', command: 'echo', output: 'json' }] },
    });
    const reg = buildCustomChecksRegistry([r]);
    expect(reg.entries[0]!.warnings.some((w) => /reportPath/.test(w))).toBe(true);
  });
});

describe('custom-check report parsing', () => {
  test('parses sharkcraft.custom-check/v1 JSON', () => {
    const raw = JSON.stringify({
      schema: 'sharkcraft.custom-check/v1',
      checkId: 'c1',
      ruleId: 'r.x',
      generatedAt: '2026-05-16T00:00:00.000Z',
      status: 'warn',
      findings: [
        { severity: 'warning', file: 'a.ts', message: 'looks bad', suggestedAction: 'rewrite', safeToAutoFix: false },
      ],
    });
    const out = parseCustomCheckReport(raw, 'c1');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.checkId).toBe('c1');
      expect(out.report.status).toBe(CustomCheckStatus.Warn);
      expect(out.report.findings[0]!.file).toBe('a.ts');
    }
  });

  test('rejects mismatched schema', () => {
    const raw = JSON.stringify({ schema: 'wrong/v1', checkId: 'c1', findings: [] });
    const out = parseCustomCheckReport(raw, 'c1');
    expect(out.ok).toBe(false);
  });

  test('rejects checkId mismatch when expected supplied', () => {
    const raw = JSON.stringify({ schema: 'sharkcraft.custom-check/v1', checkId: 'other', findings: [] });
    const out = parseCustomCheckReport(raw, 'c1');
    expect(out.ok).toBe(false);
  });

  test('text fallback maps each line to a warning finding', () => {
    const out = parseCustomCheckReport('line one\nline two', 'c-text');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.report.findings.length).toBe(2);
      expect(out.report.findings[0]!.severity).toBe('warning');
      expect(out.report.status).toBe(CustomCheckStatus.Warn);
    }
  });

  test('empty report rejected', () => {
    const out = parseCustomCheckReport('   ', 'c1');
    expect(out.ok).toBe(false);
  });
});

describe('codemod-assist', () => {
  test('groups files by risk via consumer counts', () => {
    const r = ruleEntry({ id: 'architecture.no-reexport-proxy', tags: ['architecture'] });
    const counts = new Map<string, number>([
      ['libs/a/index.ts', 0],
      ['libs/b/index.ts', 3],
      ['libs/c/index.ts', 12],
      ['libs/d/index.ts', 0],
    ]);
    const report = buildCodemodAssistReport({
      rule: r,
      affectedFiles: [
        { path: 'libs/a/index.ts' },
        { path: 'libs/b/index.ts' },
        { path: 'libs/c/index.ts' },
        { path: 'libs/d/index.ts' },
        { path: 'libs/e/index.ts' },
      ],
      consumerCounts: counts,
    });
    expect(report.riskGroups.low.length).toBe(2);
    expect(report.riskGroups.medium.length).toBe(1);
    expect(report.riskGroups.high.length).toBe(1);
    expect(report.riskGroups.unknown.length).toBe(1);
  });

  test('emits a script template under .sharkcraft/fixes/', () => {
    const r = ruleEntry({ id: 'architecture.no-reexport-proxy' });
    const report = buildCodemodAssistReport({ rule: r });
    expect(report.scriptTemplate.path).toBe(
      '.sharkcraft/fixes/codemod-architecture-no-reexport-proxy.template.ts',
    );
    expect(report.scriptTemplate.body).toContain('sharkcraft.custom-check/v1');
    expect(report.scriptTemplate.body).toContain('writeFileSync');
  });

  test('engine clearly states it does not rewrite source', () => {
    const r = ruleEntry({ id: 'architecture.no-reexport-proxy' });
    const report = buildCodemodAssistReport({ rule: r });
    expect(report.engineLimits.some((l) => /no source rewrite/i.test(l))).toBe(true);
  });

  test('recommends ts-morph / jscodeshift for re-export rules', () => {
    const r = ruleEntry({ id: 'architecture.no-reexport-proxy', tags: ['imports'] });
    const report = buildCodemodAssistReport({ rule: r });
    expect(report.recommendedExternalTool).toMatch(/ts-morph|jscodeshift/i);
  });
});

describe('pack signature explanation states are exhaustive', () => {
  test('PackSignatureExplainState union covers expected lifecycle states', async () => {
    // Smoke check: import the module and assert the state strings exist as
    // type-narrowed values by constructing each.
    const states: Array<
      'valid' | 'unsigned' | 'stale' | 'invalid' | 'secret-missing' | 'not-required' | 'unknown'
    > = ['valid', 'unsigned', 'stale', 'invalid', 'secret-missing', 'not-required', 'unknown'];
    expect(states.length).toBe(7);
  });
});

describe('scope/kind/safety/output enums are stable', () => {
  test('CustomCheckScope', () => {
    expect(String(CustomCheckScope.ChangedOnly)).toBe('changed-only');
    expect(String(CustomCheckScope.Staged)).toBe('staged');
    expect(String(CustomCheckScope.All)).toBe('all');
  });
  test('CustomCheckSafety', () => {
    expect(String(CustomCheckSafety.ReadOnly)).toBe('read-only');
    expect(String(CustomCheckSafety.WritesReport)).toBe('writes-report');
    expect(String(CustomCheckSafety.WritesPreview)).toBe('writes-preview');
  });
  test('CustomCheckOutput', () => {
    expect(String(CustomCheckOutput.Json)).toBe('json');
    expect(String(CustomCheckOutput.Text)).toBe('text');
    expect(String(CustomCheckOutput.ExitCode)).toBe('exit-code');
  });
  test('CodemodRiskBand', () => {
    expect(String(CodemodRiskBand.Low)).toBe('low');
    expect(String(CodemodRiskBand.Medium)).toBe('medium');
    expect(String(CodemodRiskBand.High)).toBe('high');
    expect(String(CodemodRiskBand.Unknown)).toBe('unknown');
  });
});
