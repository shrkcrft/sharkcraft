import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  buildLanguageCommandReport,
  computePolyglotTestImpact,
  detectLanguageProfiles,
  LanguageId,
  scanPolyglotDependencies,
  suggestLanguageBoundaries,
} from '../index.ts';

function makeTempProject(spec: Record<string, string>): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r25-lang-'));
  for (const [relPath, body] of Object.entries(spec)) {
    const abs = nodePath.join(root, relPath);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('language detection', () => {
  it('detects Java Maven', () => {
    const root = makeTempProject({
      'pom.xml': '<project><artifactId>x</artifactId></project>',
      'src/main/java/com/example/Greet.java': 'package com.example; public class Greet {}',
      'src/test/java/com/example/GreetTest.java': 'package com.example; class GreetTest {}',
    });
    const r = detectLanguageProfiles(root);
    rmSync(root, { recursive: true, force: true });
    expect(r.dominantLanguage).toBe(LanguageId.Java);
    const java = r.profiles.find((p) => p.language === LanguageId.Java);
    expect(java?.buildTool).toBe('maven');
  });

  it('detects Java Gradle', () => {
    const root = makeTempProject({
      'build.gradle': 'plugins { id "java" }',
      'src/main/java/com/example/Greet.java': 'package com.example; public class Greet {}',
    });
    const r = detectLanguageProfiles(root);
    rmSync(root, { recursive: true, force: true });
    const java = r.profiles.find((p) => p.language === LanguageId.Java);
    expect(java?.buildTool).toBe('gradle');
  });

  it('detects C# dotnet', () => {
    const root = makeTempProject({
      'src/X.csproj': '<Project><PropertyGroup /></Project>',
      'src/Greet.cs': 'namespace X; public class Greet {}',
    });
    const r = detectLanguageProfiles(root);
    rmSync(root, { recursive: true, force: true });
    expect(r.dominantLanguage).toBe(LanguageId.CSharp);
  });

  it('detects Python pytest', () => {
    const root = makeTempProject({
      'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'src/myapp/greet.py': 'def hello(name): return f"Hello, {name}!"',
    });
    const r = detectLanguageProfiles(root);
    rmSync(root, { recursive: true, force: true });
    expect(r.dominantLanguage).toBe(LanguageId.Python);
  });

  it('detects Go module', () => {
    const root = makeTempProject({
      'go.mod': 'module example.com/x\n\ngo 1.22\n',
      'main.go': 'package main\n\nfunc main() {}',
    });
    const r = detectLanguageProfiles(root);
    rmSync(root, { recursive: true, force: true });
    expect(r.dominantLanguage).toBe(LanguageId.Go);
  });

  it('detects Rust Cargo', () => {
    const root = makeTempProject({
      'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn hello() {}',
    });
    const r = detectLanguageProfiles(root);
    rmSync(root, { recursive: true, force: true });
    expect(r.dominantLanguage).toBe(LanguageId.Rust);
  });

  it('mixed repo lists multiple profiles', () => {
    const root = makeTempProject({
      'package.json': '{"name":"x"}',
      'src/main.ts': 'export const x = 1;',
      'go.mod': 'module example.com/x\n\ngo 1.22\n',
      'pkg/foo/foo.go': 'package foo',
    });
    const r = detectLanguageProfiles(root);
    rmSync(root, { recursive: true, force: true });
    const langs = new Set(r.profiles.map((p) => p.language));
    expect(langs.has(LanguageId.TypeScript)).toBe(true);
    expect(langs.has(LanguageId.Go)).toBe(true);
  });
});

describe('command inference', () => {
  it('Java Maven returns mvn test', () => {
    const root = makeTempProject({
      'pom.xml': '<project></project>',
      'src/main/java/X.java': 'class X{}',
    });
    const r = buildLanguageCommandReport(root);
    rmSync(root, { recursive: true, force: true });
    const java = r.profiles.find((p) => p.language === LanguageId.Java);
    expect(java?.test).toBe('mvn test');
  });

  it('dotnet returns dotnet test', () => {
    const root = makeTempProject({
      'X.csproj': '<Project />',
      'Foo.cs': 'class Foo {}',
    });
    const r = buildLanguageCommandReport(root);
    rmSync(root, { recursive: true, force: true });
    const cs = r.profiles.find((p) => p.language === LanguageId.CSharp);
    expect(cs?.test).toBe('dotnet test');
  });

  it('go returns go test ./...', () => {
    const root = makeTempProject({
      'go.mod': 'module x\ngo 1.22\n',
      'main.go': 'package main',
    });
    const r = buildLanguageCommandReport(root);
    rmSync(root, { recursive: true, force: true });
    const go = r.profiles.find((p) => p.language === LanguageId.Go);
    expect(go?.test).toBe('go test ./...');
  });

  it('cargo returns cargo test', () => {
    const root = makeTempProject({
      'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\nedition="2021"\n',
      'src/lib.rs': 'pub fn x() {}',
    });
    const r = buildLanguageCommandReport(root);
    rmSync(root, { recursive: true, force: true });
    const rust = r.profiles.find((p) => p.language === LanguageId.Rust);
    expect(rust?.test).toBe('cargo test');
  });
});

describe('dependency scanning', () => {
  it('parses Java imports', () => {
    const root = makeTempProject({
      'src/main/java/com/example/Foo.java':
        'package com.example;\nimport java.util.List;\nimport com.example.util.Helper;\nclass Foo {}',
    });
    const g = scanPolyglotDependencies(root, { languages: [LanguageId.Java] });
    rmSync(root, { recursive: true, force: true });
    const java = g.perLanguage[0]!;
    expect(java.imports.map((i) => i.to)).toContain('java.util.List');
    expect(java.imports.map((i) => i.to)).toContain('com.example.util.Helper');
  });

  it('parses C# usings', () => {
    const root = makeTempProject({
      'Foo.cs': 'namespace X;\nusing System.Linq;\nusing X.Internal;\n',
    });
    const g = scanPolyglotDependencies(root, { languages: [LanguageId.CSharp] });
    rmSync(root, { recursive: true, force: true });
    const cs = g.perLanguage[0]!;
    expect(cs.imports.map((i) => i.to)).toContain('System.Linq');
    expect(cs.imports.find((i) => i.to === 'X.Internal')?.external).toBe(false);
  });

  it('parses Python imports', () => {
    const root = makeTempProject({
      'src/myapp/main.py': 'import os\nfrom myapp.utils import helper\n',
    });
    const g = scanPolyglotDependencies(root, { languages: [LanguageId.Python] });
    rmSync(root, { recursive: true, force: true });
    const py = g.perLanguage[0]!;
    const tos = py.imports.map((i) => i.to);
    expect(tos).toContain('os');
    expect(tos).toContain('myapp.utils');
  });

  it('parses Go imports with module-aware internal classification', () => {
    const root = makeTempProject({
      'go.mod': 'module example.com/mymod\n\ngo 1.22\n',
      'main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/mymod/pkg/foo"\n)',
    });
    const g = scanPolyglotDependencies(root, { languages: [LanguageId.Go] });
    rmSync(root, { recursive: true, force: true });
    const go = g.perLanguage[0]!;
    expect(go.imports.find((i) => i.to === 'fmt')?.external).toBe(true);
    expect(go.imports.find((i) => i.to === 'example.com/mymod/pkg/foo')?.external).toBe(false);
  });

  it('parses Rust use + mod', () => {
    const root = makeTempProject({
      'Cargo.toml': '[package]\nname="x"\nversion="0.1.0"\nedition="2021"\n',
      'src/lib.rs': 'mod foo;\nuse serde::Serialize;\nuse crate::foo::Bar;\n',
    });
    const g = scanPolyglotDependencies(root, { languages: [LanguageId.Rust] });
    rmSync(root, { recursive: true, force: true });
    const rust = g.perLanguage[0]!;
    const tos = rust.imports.map((i) => i.to);
    expect(tos).toContain('serde::Serialize');
    expect(tos).toContain('crate::foo::Bar');
    expect(tos.some((t) => t.startsWith('mod::'))).toBe(true);
  });
});

describe('test impact', () => {
  it('Java: src/main → src/test/ + *Test.java', () => {
    const root = makeTempProject({});
    const r = computePolyglotTestImpact(root, ['src/main/java/com/example/Foo.java']);
    rmSync(root, { recursive: true, force: true });
    expect(r.impacted[0]!.predictedTests).toContain('src/test/java/com/example/FooTest.java');
  });

  it('C#: Foo.cs → FooTests.cs + sibling tests/', () => {
    const root = makeTempProject({});
    const r = computePolyglotTestImpact(root, ['src/Foo.cs']);
    rmSync(root, { recursive: true, force: true });
    expect(r.impacted[0]!.predictedTests).toContain('src/FooTests.cs');
    expect(r.impacted[0]!.predictedTests.some((t) => t.includes('tests/'))).toBe(true);
  });

  it('Python: bar.py → test_bar.py', () => {
    const root = makeTempProject({});
    const r = computePolyglotTestImpact(root, ['src/myapp/bar.py']);
    rmSync(root, { recursive: true, force: true });
    expect(r.impacted[0]!.predictedTests.some((t) => t.endsWith('test_bar.py'))).toBe(true);
  });

  it('Go: foo.go → foo_test.go', () => {
    const root = makeTempProject({});
    const r = computePolyglotTestImpact(root, ['pkg/foo.go']);
    rmSync(root, { recursive: true, force: true });
    expect(r.impacted[0]!.predictedTests).toContain('pkg/foo_test.go');
  });

  it('Rust: src/foo.rs → tests/foo.rs', () => {
    const root = makeTempProject({});
    const r = computePolyglotTestImpact(root, ['src/foo.rs']);
    rmSync(root, { recursive: true, force: true });
    expect(r.impacted[0]!.predictedTests).toContain('tests/foo.rs');
  });
});

describe('language boundary suggestions', () => {
  it('emits Java suggestions when Java is present', () => {
    const root = makeTempProject({
      'pom.xml': '<project></project>',
      'src/main/java/com/example/Foo.java': 'package com.example;',
    });
    const r = suggestLanguageBoundaries(root);
    rmSync(root, { recursive: true, force: true });
    expect(r.suggestions.some((s) => s.language === LanguageId.Java)).toBe(true);
  });
});
