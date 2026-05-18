/**
 * Pack docs generator.
 *
 * Generates a self-contained README-style markdown for a pack: manifest
 * summary, contributions table, install/verify commands, safety notes,
 * compatibility notes, release-check result.
 *
 * Read-only — produces a body string (the caller decides where to write).
 */
import { readFileSync, existsSync } from 'node:fs';
import * as nodePath from 'node:path';

export const PACK_DOCS_SCHEMA = 'sharkcraft.pack-docs/v1';

export interface IPackDocsPreview {
  schema: typeof PACK_DOCS_SCHEMA;
  packPath: string;
  packName: string;
  packVersion: string;
  body: string;
  files: readonly string[];
}

interface IManifest {
  name?: string;
  version?: string;
  description?: string;
  sharkcraft?: {
    manifestVersion?: string;
    knowledgeFiles?: readonly string[];
    ruleFiles?: readonly string[];
    pathFiles?: readonly string[];
    templateFiles?: readonly string[];
    pipelineFiles?: readonly string[];
    docsFiles?: readonly string[];
    presetFiles?: readonly string[];
    scaffoldPatternFiles?: readonly string[];
    policyCheckFiles?: readonly string[];
    constructFiles?: readonly string[];
    constructFacetFiles?: readonly string[];
    playbookFiles?: readonly string[];
    signature?: string;
  };
}

function loadManifest(packPath: string): IManifest | null {
  const pkgJsonPath = nodePath.join(packPath, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as IManifest;
  } catch {
    return null;
  }
}

export function generatePackDocs(packPath: string): IPackDocsPreview {
  const m = loadManifest(packPath) ?? {};
  const sk = m.sharkcraft ?? {};
  const name = m.name ?? nodePath.basename(packPath);
  const version = m.version ?? '0.0.0';
  const lines: string[] = [];
  lines.push(`# ${name}`);
  lines.push('');
  if (m.description) {
    lines.push(m.description);
    lines.push('');
  }
  lines.push(`> Pack manifest: \`sharkcraft.pack/${sk.manifestVersion ?? 'v1'}\` · version **${version}**`);
  lines.push('');
  lines.push('## Contributions');
  lines.push('');
  lines.push('| kind | files |');
  lines.push('|---|---|');
  const rows: readonly { kind: string; files: readonly string[] | undefined }[] = [
    { kind: 'knowledge', files: sk.knowledgeFiles },
    { kind: 'rules', files: sk.ruleFiles },
    { kind: 'paths', files: sk.pathFiles },
    { kind: 'templates', files: sk.templateFiles },
    { kind: 'pipelines', files: sk.pipelineFiles },
    { kind: 'docs', files: sk.docsFiles },
    { kind: 'presets', files: sk.presetFiles },
    { kind: 'scaffold patterns', files: sk.scaffoldPatternFiles },
    { kind: 'policy checks', files: sk.policyCheckFiles },
    { kind: 'constructs', files: sk.constructFiles },
    { kind: 'construct facets', files: sk.constructFacetFiles },
    { kind: 'playbooks', files: sk.playbookFiles },
  ];
  let totalFiles = 0;
  const allFiles: string[] = [];
  for (const r of rows) {
    const count = r.files?.length ?? 0;
    if (count === 0) continue;
    totalFiles += count;
    lines.push(`| ${r.kind} | ${count} |`);
    if (r.files) allFiles.push(...r.files);
  }
  if (totalFiles === 0) lines.push('| (none) | 0 |');
  lines.push('');
  lines.push('## Install + verify');
  lines.push('');
  lines.push('```bash');
  lines.push(`bun add ${name}`);
  lines.push('shrk packs doctor --require-signatures');
  lines.push(`shrk packs release-check ${name}`);
  lines.push('```');
  lines.push('');
  lines.push('## Safety notes');
  lines.push('');
  lines.push(
    '- SharkCraft never auto-runs pack-contributed verification commands. Only commands listed in your local `sharkcraft.config.ts verificationCommands[]` are eligible for `shrk apply --validate`.',
  );
  lines.push(
    `- The pack manifest can be HMAC-signed; verify with \`shrk packs verify ${name}\` after install.`,
  );
  if (sk.signature) {
    lines.push('- This pack ships a signed manifest.');
  } else {
    lines.push(
      '- This pack does **not** ship a signed manifest. Sign it before publishing: `shrk packs sign <path> --verify-after-sign`.',
    );
  }
  lines.push('');
  lines.push('## Compatibility');
  lines.push('');
  lines.push(
    '- Run `shrk packs compat <pack-path> --consumer-root <repo> --dist-aware` to detect helper-missing or symbol-missing issues against your installed `@shrkcrft/plugin-api`.',
  );
  lines.push('');
  return {
    schema: PACK_DOCS_SCHEMA,
    packPath,
    packName: name,
    packVersion: version,
    body: lines.join('\n') + '\n',
    files: allFiles,
  };
}
