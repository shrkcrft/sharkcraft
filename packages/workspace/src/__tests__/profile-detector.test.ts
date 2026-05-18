import { describe, expect, test } from 'bun:test';
import { WorkspaceProfile, detectProfiles } from '../profile-detector.ts';

describe('detectProfiles', () => {
  test('detects bun + typescript + tests', () => {
    const r = detectProfiles({
      packageJson: {
        name: 'x',
        version: '1.0.0',
        dependencies: { '@types/bun': '*' },
        scripts: { test: 'bun test' },
      },
      frameworks: [],
      topLevelDirs: ['src', 'tests'],
      hasTsConfig: true,
    });
    expect(r.profiles).toContain(WorkspaceProfile.HasBun);
    expect(r.profiles).toContain(WorkspaceProfile.HasTypeScript);
    expect(r.profiles).toContain(WorkspaceProfile.HasBunTest);
    expect(r.profiles).toContain(WorkspaceProfile.HasTests);
  });

  test('detects nx + monorepo, but not library when apps/ present', () => {
    const r = detectProfiles({
      packageJson: {
        name: 'x',
        version: '1.0.0',
        main: './src/index.ts',
        dependencies: { nx: '*' },
      },
      frameworks: [],
      topLevelDirs: ['packages', 'apps', 'libs'],
      hasTsConfig: true,
    });
    expect(r.profiles).toContain(WorkspaceProfile.HasNx);
    expect(r.profiles).toContain(WorkspaceProfile.IsMonorepo);
    // IsLibrary is intentionally skipped when an apps/ dir is present.
    expect(r.profiles).not.toContain(WorkspaceProfile.IsLibrary);
  });

  test('detects library when main is set and no apps/ dir is present', () => {
    const r = detectProfiles({
      packageJson: { name: 'x', version: '1.0.0', main: './src/index.ts' },
      frameworks: [],
      topLevelDirs: ['src'],
      hasTsConfig: true,
    });
    expect(r.profiles).toContain(WorkspaceProfile.IsLibrary);
  });

  test('detects next.js, turborepo, biome', () => {
    const r = detectProfiles({
      packageJson: {
        name: 'x',
        version: '1.0.0',
        dependencies: { next: '*', react: '*' },
        devDependencies: { turbo: '*', '@biomejs/biome': '*' },
      },
      frameworks: [],
      topLevelDirs: [],
      hasTsConfig: true,
    });
    expect(r.profiles).toContain(WorkspaceProfile.HasNext);
    expect(r.profiles).toContain(WorkspaceProfile.HasReact);
    expect(r.profiles).toContain(WorkspaceProfile.HasTurborepo);
    expect(r.profiles).toContain(WorkspaceProfile.HasBiome);
    expect(r.profiles).toContain(WorkspaceProfile.IsFrontend);
  });

  test('frontend + backend coexist when both deps are present', () => {
    const r = detectProfiles({
      packageJson: {
        name: 'x',
        version: '1.0.0',
        dependencies: { react: '*', express: '*' },
      },
      frameworks: [],
      topLevelDirs: [],
      hasTsConfig: false,
    });
    expect(r.profiles).toContain(WorkspaceProfile.HasReact);
    expect(r.profiles).toContain(WorkspaceProfile.IsFrontend);
    expect(r.profiles).toContain(WorkspaceProfile.IsBackend);
  });
});
