/**
 * Polyglot test impact.
 *
 * Given a set of changed source files, predict the per-language test files
 * that should run. Deterministic naming conventions per language.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { LanguageId } from './language-id.ts';

export const POLYGLOT_TEST_IMPACT_SCHEMA = 'sharkcraft.polyglot-test-impact/v1';

export interface IPolyglotImpactedTest {
  sourceFile: string;
  language: LanguageId;
  predictedTests: readonly string[];
  reason: string;
}

export interface IPolyglotTestImpact {
  schema: typeof POLYGLOT_TEST_IMPACT_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  impacted: readonly IPolyglotImpactedTest[];
  missingTests: readonly string[];
  notes: readonly string[];
}

function classifyExtension(file: string): LanguageId {
  if (file.endsWith('.java')) return LanguageId.Java;
  if (file.endsWith('.cs')) return LanguageId.CSharp;
  if (file.endsWith('.py')) return LanguageId.Python;
  if (file.endsWith('.go')) return LanguageId.Go;
  if (file.endsWith('.rs')) return LanguageId.Rust;
  if (file.endsWith('.ts') || file.endsWith('.tsx')) return LanguageId.TypeScript;
  if (file.endsWith('.js') || file.endsWith('.jsx')) return LanguageId.JavaScript;
  return LanguageId.Unknown;
}

function predictJava(file: string): string[] {
  const out = new Set<string>();
  const inMain = file.replace('/main/java/', '/test/java/');
  if (inMain !== file) {
    out.add(inMain.replace(/\.java$/, 'Test.java'));
    out.add(inMain.replace(/\.java$/, 'Tests.java'));
    out.add(inMain.replace(/\.java$/, 'IT.java'));
  } else {
    out.add(file.replace(/\.java$/, 'Test.java'));
  }
  return [...out];
}

function predictCSharp(file: string): string[] {
  const dir = nodePath.dirname(file);
  const base = nodePath.basename(file, '.cs');
  const candidates: string[] = [];
  candidates.push(nodePath.join(dir, `${base}Tests.cs`));
  candidates.push(nodePath.join(dir, `${base}Test.cs`));
  // Mirror to a sibling `*.Tests` project — covers both `/src/` (mid-path)
  // and `src/` (root-relative) layouts.
  if (file.includes('/src/')) candidates.push(file.replace(/\/src\//, '/tests/').replace(/\.cs$/, 'Tests.cs'));
  if (file.startsWith('src/')) candidates.push('tests/' + file.slice('src/'.length).replace(/\.cs$/, 'Tests.cs'));
  return candidates;
}

function predictPython(file: string): string[] {
  const dir = nodePath.dirname(file);
  const base = nodePath.basename(file, '.py');
  return [
    nodePath.join(dir, `test_${base}.py`),
    nodePath.join(dir, `${base}_test.py`),
    file.replace(/\/src\//, '/tests/').replace(/\/([^/]+)\.py$/, '/test_$1.py'),
    nodePath.join('tests', `test_${base}.py`),
  ];
}

function predictGo(file: string): string[] {
  return [file.replace(/\.go$/, '_test.go')];
}

function predictRust(file: string): string[] {
  const out: string[] = [];
  // Inline `#[cfg(test)] mod tests {}` lives in the file itself — flag it.
  out.push(file);
  // Mirror to `tests/<basename>.rs` for integration tests.
  const base = nodePath.basename(file, '.rs');
  out.push(nodePath.join('tests', `${base}.rs`));
  return out;
}

function predictTs(file: string): string[] {
  const out: string[] = [];
  out.push(file.replace(/\.tsx?$/, '.test.ts'));
  out.push(file.replace(/\.tsx?$/, '.spec.ts'));
  out.push(file.replace(/\/src\//, '/__tests__/').replace(/\.tsx?$/, '.test.ts'));
  return out;
}

export function computePolyglotTestImpact(
  projectRoot: string,
  changedFiles: readonly string[],
): IPolyglotTestImpact {
  const impacted: IPolyglotImpactedTest[] = [];
  const missing: string[] = [];
  for (const raw of changedFiles) {
    const rel = raw.startsWith('/') ? nodePath.relative(projectRoot, raw) : raw;
    const lang = classifyExtension(rel);
    let predicted: string[];
    let reason: string;
    switch (lang) {
      case LanguageId.Java:
        predicted = predictJava(rel);
        reason = 'src/main/java → src/test/java; *Test / *Tests / *IT.';
        break;
      case LanguageId.CSharp:
        predicted = predictCSharp(rel);
        reason = 'FooTests.cs / FooTest.cs; sibling Tests project.';
        break;
      case LanguageId.Python:
        predicted = predictPython(rel);
        reason = 'test_*.py / *_test.py; tests/ mirror.';
        break;
      case LanguageId.Go:
        predicted = predictGo(rel);
        reason = 'foo.go → foo_test.go.';
        break;
      case LanguageId.Rust:
        predicted = predictRust(rel);
        reason = 'inline #[cfg(test)] + tests/ integration.';
        break;
      case LanguageId.TypeScript:
      case LanguageId.JavaScript:
        predicted = predictTs(rel);
        reason = '.test.ts / .spec.ts companion.';
        break;
      default:
        predicted = [];
        reason = `No prediction rule for ${lang}.`;
    }
    impacted.push({ sourceFile: rel, language: lang, predictedTests: predicted, reason });
    const anyExists = predicted.some((t) => existsSync(nodePath.join(projectRoot, t)));
    if (predicted.length > 0 && !anyExists && lang !== LanguageId.Unknown) {
      missing.push(rel);
    }
  }
  return {
    schema: POLYGLOT_TEST_IMPACT_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    impacted,
    missingTests: missing,
    notes: ['Predictions are deterministic and naive; they do not run tests.'],
  };
}

export function renderPolyglotTestImpactText(r: IPolyglotTestImpact): string {
  let out = `=== Polyglot test impact ===\n`;
  out += `  project root   ${r.projectRoot}\n`;
  out += `  changed files  ${r.impacted.length}\n`;
  out += `  missing tests  ${r.missingTests.length}\n\n`;
  for (const i of r.impacted) {
    out += `[${i.language}] ${i.sourceFile}\n`;
    out += `  reason: ${i.reason}\n`;
    for (const t of i.predictedTests) {
      const exists = existsSync(nodePath.join(r.projectRoot, t)) ? '✓' : ' ';
      out += `  ${exists}  ${t}\n`;
    }
    out += `\n`;
  }
  if (r.missingTests.length > 0) {
    out += `Missing tests for:\n`;
    for (const m of r.missingTests) out += `  • ${m}\n`;
  }
  return out;
}
