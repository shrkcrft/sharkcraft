/**
 * Polyglot command inference.
 *
 * Given a `ILanguageProfileReport`, produce a deterministic per-language
 * `ILanguageCommandSet` for install / typecheck / test / lint / format /
 * build / package / run. The set is *advisory* — `shrk apply` still only runs
 * commands in `sharkcraft.config.ts verificationCommands[]`.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  detectLanguageProfiles,
  type ILanguageProfile,
  type ILanguageProfileReport,
} from './language-detection.ts';
import { LanguageId } from './language-id.ts';

export const LANGUAGE_COMMAND_SET_SCHEMA = 'sharkcraft.language-command-set/v1';

export interface ILanguageCommandSet {
  schema: typeof LANGUAGE_COMMAND_SET_SCHEMA;
  language: LanguageId;
  install?: string;
  restore?: string;
  typecheck?: string;
  test?: string;
  lint?: string;
  format?: string;
  build?: string;
  package?: string;
  run?: string;
  notes: readonly string[];
}

export interface ILanguageCommandReport {
  schema: typeof LANGUAGE_COMMAND_SET_SCHEMA;
  generatedAt: string;
  projectRoot: string;
  profiles: readonly ILanguageCommandSet[];
}

function commandSetFor(root: string, p: ILanguageProfile): ILanguageCommandSet {
  const notes: string[] = [];
  switch (p.language) {
    case LanguageId.TypeScript:
    case LanguageId.JavaScript: {
      const pm = p.packageManager ?? 'npm';
      const out: ILanguageCommandSet = {
        schema: LANGUAGE_COMMAND_SET_SCHEMA,
        language: p.language,
        install: `${pm} install`,
        test: pm === 'bun' ? 'bun test' : `${pm} test`,
        typecheck: 'bun x tsc --noEmit',
        notes,
      };
      if (existsSync(nodePath.join(root, '.eslintrc')) || existsSync(nodePath.join(root, '.eslintrc.json')) || existsSync(nodePath.join(root, '.eslintrc.cjs'))) {
        out.lint = `${pm === 'bun' ? 'bun x' : 'npx'} eslint .`;
      }
      if (existsSync(nodePath.join(root, '.prettierrc')) || existsSync(nodePath.join(root, '.prettierrc.json'))) {
        out.format = `${pm === 'bun' ? 'bun x' : 'npx'} prettier --check .`;
      }
      return out;
    }
    case LanguageId.Java: {
      if (p.buildTool === 'maven') {
        return {
          schema: LANGUAGE_COMMAND_SET_SCHEMA,
          language: p.language,
          install: 'mvn install -DskipTests',
          test: 'mvn test',
          typecheck: 'mvn compile',
          build: 'mvn package',
          package: 'mvn package',
          run: p.frameworkSignals.includes('spring-boot') ? 'mvn spring-boot:run' : 'mvn exec:java',
          notes,
        };
      }
      // Gradle path
      const wrapperPresent = existsSync(nodePath.join(root, 'gradlew'));
      const gradleCmd = wrapperPresent ? './gradlew' : 'gradle';
      if (!wrapperPresent) notes.push('No gradle wrapper detected — falling back to system `gradle`.');
      return {
        schema: LANGUAGE_COMMAND_SET_SCHEMA,
        language: p.language,
        install: `${gradleCmd} dependencies --refresh-dependencies`,
        test: `${gradleCmd} test`,
        typecheck: `${gradleCmd} check`,
        build: `${gradleCmd} build`,
        package: `${gradleCmd} build`,
        run: p.frameworkSignals.includes('spring-boot') ? `${gradleCmd} bootRun` : `${gradleCmd} run`,
        notes,
      };
    }
    case LanguageId.CSharp:
      return {
        schema: LANGUAGE_COMMAND_SET_SCHEMA,
        language: p.language,
        restore: 'dotnet restore',
        test: 'dotnet test',
        typecheck: 'dotnet build --no-restore',
        build: 'dotnet build',
        format: 'dotnet format --verify-no-changes',
        run: 'dotnet run',
        notes,
      };
    case LanguageId.Python: {
      const pm = p.packageManager;
      if (pm === 'uv') {
        return {
          schema: LANGUAGE_COMMAND_SET_SCHEMA,
          language: p.language,
          install: 'uv sync',
          test: 'uv run pytest',
          typecheck: p.frameworkSignals.includes('mypy') ? 'uv run mypy .' : undefined as never,
          lint: p.frameworkSignals.includes('ruff') ? 'uv run ruff check .' : undefined as never,
          format: p.frameworkSignals.includes('ruff') ? 'uv run ruff format --check .' : undefined as never,
          notes,
        };
      }
      if (pm === 'poetry') {
        return {
          schema: LANGUAGE_COMMAND_SET_SCHEMA,
          language: p.language,
          install: 'poetry install',
          test: 'poetry run pytest',
          typecheck: p.frameworkSignals.includes('mypy') ? 'poetry run mypy .' : undefined as never,
          lint: p.frameworkSignals.includes('ruff') ? 'poetry run ruff check .' : undefined as never,
          notes,
        };
      }
      return {
        schema: LANGUAGE_COMMAND_SET_SCHEMA,
        language: p.language,
        install: 'python -m pip install -r requirements.txt',
        test: 'python -m pytest',
        typecheck: p.frameworkSignals.includes('mypy') ? 'mypy .' : undefined as never,
        lint: p.frameworkSignals.includes('ruff') ? 'ruff check .' : undefined as never,
        build: existsSync(nodePath.join(root, 'pyproject.toml')) ? 'python -m build' : undefined as never,
        notes,
      };
    }
    case LanguageId.Go:
      return {
        schema: LANGUAGE_COMMAND_SET_SCHEMA,
        language: p.language,
        install: 'go mod download',
        test: 'go test ./...',
        typecheck: 'go vet ./...',
        build: 'go build ./...',
        format: 'gofmt -l .',
        run: 'go run ./...',
        notes,
      };
    case LanguageId.Rust:
      return {
        schema: LANGUAGE_COMMAND_SET_SCHEMA,
        language: p.language,
        install: 'cargo fetch',
        test: 'cargo test',
        typecheck: 'cargo check',
        lint: 'cargo clippy -- -D warnings',
        format: 'cargo fmt --check',
        build: 'cargo build',
        run: 'cargo run',
        notes,
      };
    default:
      return { schema: LANGUAGE_COMMAND_SET_SCHEMA, language: p.language, notes };
  }
}

export function buildLanguageCommandReport(
  projectRoot: string,
  cached?: ILanguageProfileReport,
): ILanguageCommandReport {
  const profiles = cached ?? detectLanguageProfiles(projectRoot);
  return {
    schema: LANGUAGE_COMMAND_SET_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot,
    profiles: profiles.profiles.map((p) => commandSetFor(projectRoot, p)),
  };
}

export function renderLanguageCommandsText(r: ILanguageCommandReport): string {
  let out = `=== Language commands ===\n`;
  out += `  project root  ${r.projectRoot}\n\n`;
  for (const c of r.profiles) {
    out += `[${c.language}]\n`;
    if (c.install) out += `  install  : ${c.install}\n`;
    if (c.restore) out += `  restore  : ${c.restore}\n`;
    if (c.typecheck) out += `  typecheck: ${c.typecheck}\n`;
    if (c.test) out += `  test     : ${c.test}\n`;
    if (c.lint) out += `  lint     : ${c.lint}\n`;
    if (c.format) out += `  format   : ${c.format}\n`;
    if (c.build) out += `  build    : ${c.build}\n`;
    if (c.package) out += `  package  : ${c.package}\n`;
    if (c.run) out += `  run      : ${c.run}\n`;
    if (c.notes.length) {
      for (const n of c.notes) out += `  note     : ${n}\n`;
    }
    out += `\n`;
  }
  return out;
}

export function renderLanguageCommandsMarkdown(r: ILanguageCommandReport): string {
  let out = `# Language commands\n\n`;
  out += `- **project root**: ${r.projectRoot}\n\n`;
  for (const c of r.profiles) {
    out += `## ${c.language}\n`;
    if (c.install) out += `- **install**: \`${c.install}\`\n`;
    if (c.restore) out += `- **restore**: \`${c.restore}\`\n`;
    if (c.typecheck) out += `- **typecheck**: \`${c.typecheck}\`\n`;
    if (c.test) out += `- **test**: \`${c.test}\`\n`;
    if (c.lint) out += `- **lint**: \`${c.lint}\`\n`;
    if (c.format) out += `- **format**: \`${c.format}\`\n`;
    if (c.build) out += `- **build**: \`${c.build}\`\n`;
    if (c.package) out += `- **package**: \`${c.package}\`\n`;
    if (c.run) out += `- **run**: \`${c.run}\`\n`;
    if (c.notes.length) {
      for (const n of c.notes) out += `- _note_: ${n}\n`;
    }
    out += `\n`;
  }
  return out;
}
