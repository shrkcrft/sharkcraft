import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { renderPolyglotGitHubActionsJobs } from '../index.ts';

function tempProject(spec: Record<string, string>): string {
  const root = mkdtempSync(nodePath.join(tmpdir(), 'shrk-r25-ci-'));
  for (const [rel, body] of Object.entries(spec)) {
    const abs = nodePath.join(root, rel);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe('polyglot CI scaffold', () => {
  it('emits Maven + Go jobs when both languages are present', () => {
    const root = tempProject({
      'pom.xml': '<project></project>',
      'src/main/java/X.java': 'class X{}',
      'go.mod': 'module example.com/x\n\ngo 1.22\n',
      'main.go': 'package main',
    });
    const yaml = renderPolyglotGitHubActionsJobs(root);
    rmSync(root, { recursive: true, force: true });
    expect(yaml).toContain('mvn -B verify');
    expect(yaml).toContain('go test ./...');
    expect(yaml).toContain('actions/setup-java@v4');
    expect(yaml).toContain('actions/setup-go@v5');
  });

  it('emits dotnet test when C# is present', () => {
    const root = tempProject({
      'X.csproj': '<Project />',
      'Foo.cs': 'class Foo {}',
    });
    const yaml = renderPolyglotGitHubActionsJobs(root);
    rmSync(root, { recursive: true, force: true });
    expect(yaml).toContain('dotnet test --no-build');
    expect(yaml).toContain('actions/setup-dotnet@v4');
  });

  it('emits no language jobs for a pure-TS repo', () => {
    const root = tempProject({
      'package.json': '{"name":"x"}',
      'src/main.ts': 'export const x = 1;',
    });
    const yaml = renderPolyglotGitHubActionsJobs(root);
    rmSync(root, { recursive: true, force: true });
    expect(yaml).toContain('(no non-JS/TS languages detected');
  });
});
