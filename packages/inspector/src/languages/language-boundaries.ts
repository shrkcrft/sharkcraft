/**
 * Polyglot boundary suggestions.
 *
 * Produces *suggested* boundary rules per detected language. These are
 * conservative defaults (Java domain→infra, Python domain→web framework, …)
 * surfaced via `shrk boundaries infer --language all`. The user reviews and
 * copies keepers into `sharkcraft/boundaries.ts`. The existing TS-aware
 * boundary engine is unchanged.
 */
import { LanguageId } from './language-id.ts';
import { detectLanguageProfiles, type ILanguageProfile } from './language-detection.ts';

export interface ILanguageBoundarySuggestion {
  id: string;
  title: string;
  severity: 'error' | 'warning';
  language: LanguageId;
  fromGlob: string;
  forbiddenImports: readonly string[];
  reason: string;
  example: string;
}

export interface ILanguageBoundarySuggestionReport {
  generatedAt: string;
  projectRoot: string;
  suggestions: readonly ILanguageBoundarySuggestion[];
  notes: readonly string[];
}

function javaSuggestions(profile: ILanguageProfile): ILanguageBoundarySuggestion[] {
  const out: ILanguageBoundarySuggestion[] = [];
  out.push({
    id: 'java.controller-not-importing-repository',
    title: 'Controllers should not import repositories directly',
    severity: 'warning',
    language: LanguageId.Java,
    fromGlob: '**/controller/**',
    forbiddenImports: ['*.repository.*', '*.dao.*'],
    reason: 'Routing layer should depend on service layer, not on persistence directly.',
    example: 'src/main/java/com/foo/controller/UserController.java importing com.foo.repository.UserRepository',
  });
  out.push({
    id: 'java.domain-not-importing-infrastructure',
    title: 'Domain must not import infrastructure',
    severity: 'error',
    language: LanguageId.Java,
    fromGlob: '**/domain/**',
    forbiddenImports: ['*.infrastructure.*', '*.config.*'],
    reason: 'Domain stays independent of frameworks / database / IO.',
    example: 'com.foo.domain.User importing com.foo.infrastructure.UserRepositoryImpl',
  });
  if (profile.frameworkSignals.includes('spring-boot')) {
    out.push({
      id: 'java.domain-not-importing-springboot',
      title: 'Domain should not import Spring',
      severity: 'warning',
      language: LanguageId.Java,
      fromGlob: '**/domain/**',
      forbiddenImports: ['org.springframework.*'],
      reason: 'Keep domain framework-agnostic.',
      example: 'com.foo.domain.* importing org.springframework.*',
    });
  }
  return out;
}

function csharpSuggestions(profile: ILanguageProfile): ILanguageBoundarySuggestion[] {
  const out: ILanguageBoundarySuggestion[] = [];
  out.push({
    id: 'csharp.domain-not-depending-on-infrastructure',
    title: 'Domain project must not depend on Infrastructure / Web',
    severity: 'error',
    language: LanguageId.CSharp,
    fromGlob: '**/Domain/**',
    forbiddenImports: ['*.Infrastructure.*', '*.Web.*'],
    reason: 'Onion / Clean architecture: outer layers depend inward.',
    example: 'Domain.Foo importing Infrastructure.Repositories.FooRepository',
  });
  out.push({
    id: 'csharp.web-not-depending-on-domain-directly',
    title: 'Web project depends on Application, not Domain',
    severity: 'warning',
    language: LanguageId.CSharp,
    fromGlob: '**/Web/**',
    forbiddenImports: ['*.Domain.*'],
    reason: 'Application orchestrates Domain; Web should not call Domain directly.',
    example: 'Web.Controllers.UserController importing Domain.Entities.User',
  });
  void profile;
  return out;
}

function pythonSuggestions(profile: ILanguageProfile): ILanguageBoundarySuggestion[] {
  const out: ILanguageBoundarySuggestion[] = [];
  const webFramework = ['fastapi', 'django', 'flask'].filter((f) => profile.frameworkSignals.includes(f));
  if (webFramework.length > 0) {
    out.push({
      id: 'python.domain-not-importing-web-framework',
      title: `Domain must not import ${webFramework.join(' / ')}`,
      severity: 'error',
      language: LanguageId.Python,
      fromGlob: '**/domain/**',
      forbiddenImports: webFramework,
      reason: 'Domain stays framework-agnostic.',
      example: 'domain/user.py importing fastapi.FastAPI',
    });
  }
  out.push({
    id: 'python.app-not-importing-tests',
    title: 'Application code must not import tests',
    severity: 'error',
    language: LanguageId.Python,
    fromGlob: 'src/**',
    forbiddenImports: ['tests.*', 'test_*'],
    reason: 'Production code must not depend on the test tree.',
    example: 'src/foo.py importing tests.fixtures.user_fixture',
  });
  return out;
}

function goSuggestions(profile: ILanguageProfile): ILanguageBoundarySuggestion[] {
  const out: ILanguageBoundarySuggestion[] = [];
  out.push({
    id: 'go.no-importing-internal-from-outside',
    title: 'Packages outside parent must not import `internal/`',
    severity: 'error',
    language: LanguageId.Go,
    fromGlob: '**/*.go',
    forbiddenImports: ['*/internal/*'],
    reason: 'Go enforces the same rule at compile time; the boundary surfaces it earlier.',
    example: 'pkg/foo/foo.go importing github.com/other-module/internal/bar',
  });
  out.push({
    id: 'go.pkg-not-importing-cmd',
    title: 'pkg should not import cmd',
    severity: 'warning',
    language: LanguageId.Go,
    fromGlob: 'pkg/**',
    forbiddenImports: ['*/cmd/*'],
    reason: 'cmd/ is the entry point; library code should not depend on it.',
    example: 'pkg/foo.go importing example.com/repo/cmd/main',
  });
  void profile;
  return out;
}

function rustSuggestions(profile: ILanguageProfile): ILanguageBoundarySuggestion[] {
  const out: ILanguageBoundarySuggestion[] = [];
  out.push({
    id: 'rust.lib-not-importing-bin',
    title: 'Library crate should not depend on bin-only modules',
    severity: 'warning',
    language: LanguageId.Rust,
    fromGlob: 'src/lib.rs',
    forbiddenImports: ['crate::bin::*'],
    reason: 'Libraries should be reusable; bin modules are entry points.',
    example: 'src/lib.rs `use crate::bin::main_helper;`',
  });
  out.push({
    id: 'rust.crate-not-importing-tests',
    title: 'Crate code must not import the tests/ tree',
    severity: 'error',
    language: LanguageId.Rust,
    fromGlob: 'src/**',
    forbiddenImports: ['tests::*'],
    reason: 'Production code must not depend on the test tree.',
    example: 'src/foo.rs `use tests::fixtures::user;`',
  });
  void profile;
  return out;
}

export function suggestLanguageBoundaries(
  projectRoot: string,
  options: { language?: LanguageId } = {},
): ILanguageBoundarySuggestionReport {
  const report = detectLanguageProfiles(projectRoot);
  const out: ILanguageBoundarySuggestion[] = [];
  for (const p of report.profiles) {
    if (options.language && p.language !== options.language) continue;
    if (p.language === LanguageId.Java) out.push(...javaSuggestions(p));
    else if (p.language === LanguageId.CSharp) out.push(...csharpSuggestions(p));
    else if (p.language === LanguageId.Python) out.push(...pythonSuggestions(p));
    else if (p.language === LanguageId.Go) out.push(...goSuggestions(p));
    else if (p.language === LanguageId.Rust) out.push(...rustSuggestions(p));
  }
  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    suggestions: out,
    notes: [
      'Suggestions only. Copy keepers into sharkcraft/boundaries.ts manually.',
      'These boundaries describe *intent*; the engine itself remains TS-aware.',
    ],
  };
}
