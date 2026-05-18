/**
 * Polyglot CI scaffold.
 *
 * Emits GitHub Actions job snippets for detected language profiles. Each job
 * runs install / build / test (and optional lint/format when detected). No
 * publish/deploy steps. Output is concatenated to the existing CI YAML.
 */
import { LanguageId } from './language-id.ts';
import { detectLanguageProfiles, type ILanguageProfileReport } from './language-detection.ts';
import { buildLanguageCommandReport, type ILanguageCommandSet } from './command-inference.ts';

function jobIdFor(lang: LanguageId): string {
  return `polyglot-${lang}`;
}

function githubJobForJava(c: ILanguageCommandSet): string {
  const isMaven = c.install?.startsWith('mvn') ?? false;
  const javaVersion = '21';
  let yaml = `  ${jobIdFor(c.language)}:\n`;
  yaml += `    runs-on: ubuntu-latest\n`;
  yaml += `    timeout-minutes: 25\n`;
  yaml += `    steps:\n`;
  yaml += `      - uses: actions/checkout@v4\n`;
  yaml += `      - uses: actions/setup-java@v4\n`;
  yaml += `        with:\n`;
  yaml += `          distribution: temurin\n`;
  yaml += `          java-version: '${javaVersion}'\n`;
  if (isMaven) {
    yaml += `          cache: maven\n`;
    yaml += `      - run: mvn -B verify\n`;
  } else {
    yaml += `          cache: gradle\n`;
    yaml += `      - run: ./gradlew test\n`;
  }
  return yaml;
}

function githubJobForCSharp(_c: ILanguageCommandSet): string {
  let yaml = `  polyglot-csharp:\n`;
  yaml += `    runs-on: ubuntu-latest\n`;
  yaml += `    timeout-minutes: 25\n`;
  yaml += `    steps:\n`;
  yaml += `      - uses: actions/checkout@v4\n`;
  yaml += `      - uses: actions/setup-dotnet@v4\n`;
  yaml += `        with:\n`;
  yaml += `          dotnet-version: '8.x'\n`;
  yaml += `      - run: dotnet restore\n`;
  yaml += `      - run: dotnet build --no-restore\n`;
  yaml += `      - run: dotnet test --no-build\n`;
  return yaml;
}

function githubJobForPython(c: ILanguageCommandSet): string {
  let yaml = `  polyglot-python:\n`;
  yaml += `    runs-on: ubuntu-latest\n`;
  yaml += `    timeout-minutes: 20\n`;
  yaml += `    steps:\n`;
  yaml += `      - uses: actions/checkout@v4\n`;
  yaml += `      - uses: actions/setup-python@v5\n`;
  yaml += `        with:\n`;
  yaml += `          python-version: '3.12'\n`;
  if (c.install) yaml += `      - run: ${c.install}\n`;
  if (c.lint) yaml += `      - run: ${c.lint}\n`;
  if (c.typecheck) yaml += `      - run: ${c.typecheck}\n`;
  if (c.test) yaml += `      - run: ${c.test}\n`;
  return yaml;
}

function githubJobForGo(_c: ILanguageCommandSet): string {
  let yaml = `  polyglot-go:\n`;
  yaml += `    runs-on: ubuntu-latest\n`;
  yaml += `    timeout-minutes: 20\n`;
  yaml += `    steps:\n`;
  yaml += `      - uses: actions/checkout@v4\n`;
  yaml += `      - uses: actions/setup-go@v5\n`;
  yaml += `        with:\n`;
  yaml += `          go-version: '1.22'\n`;
  yaml += `      - run: go vet ./...\n`;
  yaml += `      - run: go test ./...\n`;
  return yaml;
}

function githubJobForRust(_c: ILanguageCommandSet): string {
  let yaml = `  polyglot-rust:\n`;
  yaml += `    runs-on: ubuntu-latest\n`;
  yaml += `    timeout-minutes: 25\n`;
  yaml += `    steps:\n`;
  yaml += `      - uses: actions/checkout@v4\n`;
  yaml += `      - uses: dtolnay/rust-toolchain@stable\n`;
  yaml += `      - run: cargo fmt --check\n`;
  yaml += `      - run: cargo clippy -- -D warnings\n`;
  yaml += `      - run: cargo test\n`;
  return yaml;
}

export interface IPolyglotCiOptions {
  cached?: ILanguageProfileReport;
}

export function renderPolyglotGitHubActionsJobs(
  projectRoot: string,
  options: IPolyglotCiOptions = {},
): string {
  const cmds = buildLanguageCommandReport(projectRoot, options.cached);
  let yaml = `\n  # Polyglot jobs\n`;
  let any = false;
  for (const c of cmds.profiles) {
    switch (c.language) {
      case LanguageId.Java:
        yaml += githubJobForJava(c);
        any = true;
        break;
      case LanguageId.CSharp:
        yaml += githubJobForCSharp(c);
        any = true;
        break;
      case LanguageId.Python:
        yaml += githubJobForPython(c);
        any = true;
        break;
      case LanguageId.Go:
        yaml += githubJobForGo(c);
        any = true;
        break;
      case LanguageId.Rust:
        yaml += githubJobForRust(c);
        any = true;
        break;
      default:
        break;
    }
  }
  if (!any) yaml += `  # (no non-JS/TS languages detected — nothing to add)\n`;
  return yaml;
}

export function listPolyglotCiLanguages(projectRoot: string): readonly LanguageId[] {
  const r = detectLanguageProfiles(projectRoot);
  return r.profiles
    .map((p) => p.language)
    .filter((l) => l === LanguageId.Java || l === LanguageId.CSharp || l === LanguageId.Python || l === LanguageId.Go || l === LanguageId.Rust);
}

// ---------------------------------------------------------------------------
// Provider-specific polyglot job/step renderers.
// All renderers below intentionally avoid publish/deploy/push commands.
// They emit *jobs* / *stages* / *steps* — the caller appends them to the
// existing CI scaffold under each provider's syntax.
// ---------------------------------------------------------------------------

interface IRenderPolyglotOptions {
  cached?: ILanguageProfileReport;
  /** When provided, restricts the emitted languages. */
  languages?: readonly LanguageId[];
}

function selectCommands(
  projectRoot: string,
  options: IRenderPolyglotOptions,
): readonly ILanguageCommandSet[] {
  const cmds = buildLanguageCommandReport(projectRoot, options.cached);
  if (!options.languages || options.languages.length === 0) {
    return cmds.profiles.filter((c) =>
      c.language === LanguageId.Java
      || c.language === LanguageId.CSharp
      || c.language === LanguageId.Python
      || c.language === LanguageId.Go
      || c.language === LanguageId.Rust,
    );
  }
  const wanted = new Set(options.languages);
  return cmds.profiles.filter((c) => wanted.has(c.language));
}

export function renderPolyglotGitlabJobs(
  projectRoot: string,
  options: IRenderPolyglotOptions = {},
): string {
  const cmds = selectCommands(projectRoot, options);
  if (cmds.length === 0) return '# (no non-JS/TS languages detected — no polyglot stages added)\n';
  let yaml = '\n# Polyglot stages\n';
  for (const c of cmds) {
    if (c.language === LanguageId.Java) {
      const isMaven = (c.install ?? '').startsWith('mvn');
      yaml += `polyglot:java:\n  stage: sharkcraft_quality\n  image: ${isMaven ? 'maven:3-eclipse-temurin-21' : 'gradle:8-jdk21'}\n  script:\n`;
      if (isMaven) {
        yaml += `    - mvn -B verify\n`;
      } else {
        yaml += `    - ./gradlew test\n`;
      }
    } else if (c.language === LanguageId.CSharp) {
      yaml += `polyglot:csharp:\n  stage: sharkcraft_quality\n  image: mcr.microsoft.com/dotnet/sdk:8.0\n  script:\n    - dotnet restore\n    - dotnet build --no-restore\n    - dotnet test --no-build\n`;
    } else if (c.language === LanguageId.Python) {
      yaml += `polyglot:python:\n  stage: sharkcraft_quality\n  image: python:3.12\n  script:\n`;
      if (c.install) yaml += `    - ${c.install}\n`;
      if (c.lint) yaml += `    - ${c.lint}\n`;
      if (c.typecheck) yaml += `    - ${c.typecheck}\n`;
      if (c.test) yaml += `    - ${c.test}\n`;
    } else if (c.language === LanguageId.Go) {
      yaml += `polyglot:go:\n  stage: sharkcraft_quality\n  image: golang:1.22\n  script:\n    - go vet ./...\n    - go test ./...\n`;
    } else if (c.language === LanguageId.Rust) {
      yaml += `polyglot:rust:\n  stage: sharkcraft_quality\n  image: rust:1\n  script:\n    - cargo fmt --check\n    - cargo clippy -- -D warnings\n    - cargo test\n`;
    }
  }
  return yaml;
}

export function renderPolyglotBitbucketSteps(
  projectRoot: string,
  options: IRenderPolyglotOptions = {},
): string {
  const cmds = selectCommands(projectRoot, options);
  if (cmds.length === 0) return '# (no non-JS/TS languages detected — no polyglot steps added)\n';
  let yaml = '\n# Polyglot steps\n';
  for (const c of cmds) {
    if (c.language === LanguageId.Java) {
      const isMaven = (c.install ?? '').startsWith('mvn');
      yaml += `    - step: &polyglot-java\n        name: Polyglot Java\n        image: ${isMaven ? 'maven:3-eclipse-temurin-21' : 'gradle:8-jdk21'}\n        script:\n          - ${isMaven ? 'mvn -B verify' : './gradlew test'}\n`;
    } else if (c.language === LanguageId.CSharp) {
      yaml += `    - step: &polyglot-csharp\n        name: Polyglot .NET\n        image: mcr.microsoft.com/dotnet/sdk:8.0\n        script:\n          - dotnet restore\n          - dotnet build --no-restore\n          - dotnet test --no-build\n`;
    } else if (c.language === LanguageId.Python) {
      yaml += `    - step: &polyglot-python\n        name: Polyglot Python\n        image: python:3.12\n        script:\n`;
      if (c.install) yaml += `          - ${c.install}\n`;
      if (c.lint) yaml += `          - ${c.lint}\n`;
      if (c.test) yaml += `          - ${c.test}\n`;
    } else if (c.language === LanguageId.Go) {
      yaml += `    - step: &polyglot-go\n        name: Polyglot Go\n        image: golang:1.22\n        script:\n          - go vet ./...\n          - go test ./...\n`;
    } else if (c.language === LanguageId.Rust) {
      yaml += `    - step: &polyglot-rust\n        name: Polyglot Rust\n        image: rust:1\n        script:\n          - cargo fmt --check\n          - cargo clippy -- -D warnings\n          - cargo test\n`;
    }
  }
  return yaml;
}

export function renderPolyglotAzureStages(
  projectRoot: string,
  options: IRenderPolyglotOptions = {},
): string {
  const cmds = selectCommands(projectRoot, options);
  if (cmds.length === 0) return '# (no non-JS/TS languages detected — no polyglot stages added)\n';
  let yaml = '\n# Polyglot stages\n';
  for (const c of cmds) {
    if (c.language === LanguageId.Java) {
      const isMaven = (c.install ?? '').startsWith('mvn');
      yaml += `  - stage: Polyglot_Java\n    dependsOn: SharkCraft_Install\n    jobs:\n      - job: Java\n        steps:\n          - task: ${isMaven ? 'Maven@4' : 'Gradle@2'}\n            displayName: ${isMaven ? 'mvn verify' : 'gradle test'}\n`;
    } else if (c.language === LanguageId.CSharp) {
      yaml += `  - stage: Polyglot_DotNet\n    dependsOn: SharkCraft_Install\n    jobs:\n      - job: DotNet\n        steps:\n          - task: UseDotNet@2\n            inputs:\n              version: '8.x'\n          - script: dotnet restore && dotnet build --no-restore && dotnet test --no-build\n            displayName: 'dotnet test'\n`;
    } else if (c.language === LanguageId.Python) {
      yaml += `  - stage: Polyglot_Python\n    dependsOn: SharkCraft_Install\n    jobs:\n      - job: Python\n        steps:\n          - task: UsePythonVersion@0\n            inputs:\n              versionSpec: '3.12'\n`;
      if (c.install) yaml += `          - script: ${c.install}\n            displayName: install\n`;
      if (c.lint) yaml += `          - script: ${c.lint}\n            displayName: lint\n`;
      if (c.test) yaml += `          - script: ${c.test}\n            displayName: test\n`;
    } else if (c.language === LanguageId.Go) {
      yaml += `  - stage: Polyglot_Go\n    dependsOn: SharkCraft_Install\n    jobs:\n      - job: Go\n        steps:\n          - task: GoTool@0\n            inputs:\n              version: '1.22'\n          - script: go vet ./... && go test ./...\n            displayName: 'go test'\n`;
    } else if (c.language === LanguageId.Rust) {
      yaml += `  - stage: Polyglot_Rust\n    dependsOn: SharkCraft_Install\n    jobs:\n      - job: Rust\n        steps:\n          - script: curl -sSf https://sh.rustup.rs | sh -s -- -y && source $HOME/.cargo/env && cargo fmt --check && cargo clippy -- -D warnings && cargo test\n            displayName: 'cargo test'\n`;
    }
  }
  return yaml;
}

export function renderPolyglotJenkinsStages(
  projectRoot: string,
  options: IRenderPolyglotOptions = {},
): string {
  const cmds = selectCommands(projectRoot, options);
  if (cmds.length === 0) return '// (no non-JS/TS languages detected — no polyglot stages added)\n';
  let groovy = '\n// Polyglot stages\n';
  for (const c of cmds) {
    if (c.language === LanguageId.Java) {
      const isMaven = (c.install ?? '').startsWith('mvn');
      groovy += `    stage('Polyglot Java') {\n      steps {\n        sh '${isMaven ? 'mvn -B verify' : './gradlew test'}'\n      }\n    }\n`;
    } else if (c.language === LanguageId.CSharp) {
      groovy += `    stage('Polyglot .NET') {\n      steps {\n        sh 'dotnet restore && dotnet build --no-restore && dotnet test --no-build'\n      }\n    }\n`;
    } else if (c.language === LanguageId.Python) {
      groovy += `    stage('Polyglot Python') {\n      steps {\n`;
      if (c.install) groovy += `        sh '${c.install}'\n`;
      if (c.lint) groovy += `        sh '${c.lint}'\n`;
      if (c.test) groovy += `        sh '${c.test}'\n`;
      groovy += `      }\n    }\n`;
    } else if (c.language === LanguageId.Go) {
      groovy += `    stage('Polyglot Go') {\n      steps {\n        sh 'go vet ./...'\n        sh 'go test ./...'\n      }\n    }\n`;
    } else if (c.language === LanguageId.Rust) {
      groovy += `    stage('Polyglot Rust') {\n      steps {\n        sh 'cargo fmt --check'\n        sh 'cargo clippy -- -D warnings'\n        sh 'cargo test'\n      }\n    }\n`;
    }
  }
  return groovy;
}
