import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IPolicyRule } from '@shrkcrft/core';
import { evaluatePolicy, type IPolicyUnit } from '../policy/evaluate-policy.ts';
import { extractInlineTemplates } from '../policy/extract-templates.ts';
import { runPolicyLint } from '../policy/run-policy.ts';

const RAW_BUTTON: IPolicyRule = {
  id: 'no-raw-button',
  surface: 'template',
  pattern: '<button',
  message: 'Raw <button> — use the shared primitive.',
  suggest: 'Use <AppButton>.',
};

describe('extractInlineTemplates', () => {
  test('extracts a multi-line backtick template with the right start line', () => {
    const src = 'line1\n@Component({\n  template: `\n    <button>x</button>\n  `,\n})\n';
    const tpls = extractInlineTemplates(src);
    expect(tpls.length).toBe(1);
    expect(tpls[0]!.body).toContain('<button>x</button>');
    // Body begins right after the backtick on line 3.
    expect(tpls[0]!.startLine).toBe(3);
  });

  test('extracts single- and double-quoted templates', () => {
    expect(extractInlineTemplates("template: '<a></a>'").length).toBe(1);
    expect(extractInlineTemplates('template: "<a></a>"').length).toBe(1);
  });

  test('ignores templateUrl', () => {
    expect(extractInlineTemplates("templateUrl: './x.html'").length).toBe(0);
  });

  test('an escaped same-delimiter quote does not truncate the body', () => {
    const tpls = extractInlineTemplates('const c = { template: "before \\" <button> after" };');
    expect(tpls.length).toBe(1);
    // Body must include content AFTER the escaped quote (no truncation).
    expect(tpls[0]!.body).toContain('<button>');
    expect(tpls[0]!.body).toContain('after');
  });
});

describe('evaluatePolicy (pure)', () => {
  test('whole match is reported when there is no capture group', () => {
    const units: IPolicyUnit[] = [{ path: 'a.html', content: '<button>x</button>', baseLine: 1 }];
    const r = evaluatePolicy([RAW_BUTTON], () => units);
    expect(r.verdict).toBe('errors');
    expect(r.findings[0]!.match).toBe('<button');
    expect(r.findings[0]!.file).toBe('a.html');
    expect(r.findings[0]!.suggest).toBe('Use <AppButton>.');
  });

  test('capture group 1 is the reported token when present', () => {
    const rule: IPolicyRule = { id: 'r', surface: 'ts', pattern: 'class=(["\\\'])(card)\\1', message: 'm' };
    const units: IPolicyUnit[] = [{ path: 'a.html', content: '<div class="card">', baseLine: 1 }];
    const r = evaluatePolicy([rule], () => units);
    expect(r.findings[0]!.match).toBe('"'); // group 1 = the quote
  });

  test('inline-template baseLine offsets the reported line', () => {
    const units: IPolicyUnit[] = [
      { path: 'x.ts', content: '<button>x</button>', baseLine: 10, inlineTemplate: true },
    ];
    const r = evaluatePolicy([RAW_BUTTON], () => units);
    expect(r.findings[0]!.line).toBe(10);
    expect(r.findings[0]!.inlineTemplate).toBe(true);
  });

  test('an uncompilable pattern degrades to a diagnostic, never throws', () => {
    const bad: IPolicyRule = { id: 'bad', surface: 'ts', pattern: '([A-Z', message: 'm' };
    let r!: ReturnType<typeof evaluatePolicy>;
    expect(() => {
      r = evaluatePolicy([bad], () => [{ path: 'a.ts', content: 'X', baseLine: 1 }]);
    }).not.toThrow();
    expect(r.verdict).toBe('errors');
    expect(r.diagnostics[0]).toContain('invalid regex');
  });

  test('warning severity does not produce an error verdict', () => {
    const r = evaluatePolicy([{ ...RAW_BUTTON, severity: 'warning' }], () => [
      { path: 'a.html', content: '<button>', baseLine: 1 },
    ]);
    expect(r.verdict).toBe('warnings');
  });

  test('a zero-width pattern is a diagnostic, not a flood of empty findings', () => {
    const zw: IPolicyRule = { id: 'zw', surface: 'style', pattern: 'a?', message: 'm' };
    const r = evaluatePolicy([zw], () => [{ path: 'a.css', content: 'body {}\n.x {}\n', baseLine: 1 }]);
    expect(r.findings.filter((f) => f.match === '').length).toBe(0); // no empty findings
    expect(r.diagnostics.some((d) => d.includes('zero-width'))).toBe(true);
    expect(r.verdict).toBe('errors');
  });
});

describe('runPolicyLint (fs-backed)', () => {
  function setup(): string {
    const root = mkdtempSync(join(tmpdir(), 'shrk-policy-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'page.html'), '<div><button>hi</button></div>\n');
    writeFileSync(
      join(root, 'src', 'x.component.ts'),
      "@Component({\n  template: `\n    <button>click</button>\n  `,\n})\nexport class X {}\n",
    );
    writeFileSync(join(root, 'src', 'styles.scss'), '.deep { color: red; }\n');
    return root;
  }

  test('flags raw markup in BOTH .html files and inline templates', () => {
    const root = setup();
    try {
      const r = runPolicyLint(root, [RAW_BUTTON]);
      expect(r.findings.length).toBe(2);
      const files = r.findings.map((f) => f.file).sort();
      expect(files).toEqual(['src/page.html', 'src/x.component.ts']);
      const inline = r.findings.find((f) => f.file.endsWith('.ts'))!;
      expect(inline.inlineTemplate).toBe(true);
      expect(inline.line).toBe(3); // the <button> line inside the inline template
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--surface restricts which rules run', () => {
    const root = setup();
    try {
      const styleRule: IPolicyRule = { id: 's', surface: 'style', pattern: '\\.deep\\b', message: 'no deep' };
      const r = runPolicyLint(root, [RAW_BUTTON, styleRule], { surfaces: ['style'] });
      expect(r.findings.every((f) => f.surface === 'style')).toBe(true);
      expect(r.findings.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--changed-only skips rules untouched by the change set', () => {
    const root = setup();
    try {
      const skipped = runPolicyLint(root, [RAW_BUTTON], { changedOnly: true, changedFiles: ['README.md'] });
      expect(skipped.rules).toEqual([]);
      const run = runPolicyLint(root, [RAW_BUTTON], { changedOnly: true, changedFiles: ['src/page.html'] });
      expect(run.findings.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dot-directories (.yarn) and excludeDirs are pruned', () => {
    const root = setup();
    try {
      mkdirSync(join(root, '.yarn', 'cache'), { recursive: true });
      writeFileSync(join(root, '.yarn', 'cache', 'dep.html'), '<button>vendored</button>\n');
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      writeFileSync(join(root, 'sharkcraft', 'config-like.html'), '<button>config</button>\n');
      const r = runPolicyLint(root, [RAW_BUTTON], { excludeDirs: ['sharkcraft'] });
      const files = r.findings.map((f) => f.file);
      expect(files.some((f) => f.startsWith('.yarn/'))).toBe(false); // dot-dir pruned
      expect(files.some((f) => f.startsWith('sharkcraft/'))).toBe(false); // excludeDirs pruned
      expect(files).toContain('src/page.html'); // real source still scanned
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
