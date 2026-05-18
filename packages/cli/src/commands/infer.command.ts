import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  inferTemplateBodyV2,
  inspectSharkcraft,
  loadScaffoldPatternsFromInspection,
  matchScaffoldPattern,
  extractVariablesForFile,
  type IInferredTemplateScaffoldV2,
  type IScaffoldPatternWithSource,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header } from '../output/format-output.ts';

const KIND_MAP: Record<string, 'service' | 'utility' | 'test' | 'component'> = {
  service: 'service',
  services: 'service',
  utility: 'utility',
  utilities: 'utility',
  util: 'utility',
  test: 'test',
  tests: 'test',
  spec: 'test',
  component: 'component',
  components: 'component',
};

interface ICandidateV2 {
  schema: 'sharkcraft.inferred-template-candidate/v2';
  matchedPattern?: { id: string; templateId: string; source: string; confidence: string };
  scaffold?: IInferredTemplateScaffoldV2;
  variables: Record<string, string>;
  warnings: string[];
  /** Suggested CLI command to scaffold this template. */
  suggestedCommand?: string;
  sample: string;
}

export const inferCommand: ICommandHandler = {
  name: 'infer',
  description:
    'Inference helpers (templates / boundaries). `shrk infer templates --ast` produces template-body draft candidates using the TypeScript compiler API when available, with scaffold-pattern–driven detection from installed packs.',
  usage:
    'shrk [--cwd <dir>] infer templates [--ast] [--kind service|utility|test|component] [--include <glob>] [--limit N] [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'templates') {
      const sliced = { ...args, positional: args.positional.slice(1) };
      return runInferTemplates(sliced);
    }
    process.stderr.write('Usage: shrk infer templates [--ast] [...]\n');
    return 2;
  },
};

async function runInferTemplates(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const useAst = flagBool(args, 'ast');
  const wantJson = flagBool(args, 'json');
  const kindRaw = flagString(args, 'kind');
  const kind: 'service' | 'utility' | 'test' | 'component' = kindRaw && KIND_MAP[kindRaw.toLowerCase()]
    ? KIND_MAP[kindRaw.toLowerCase()]!
    : 'service';
  const limit = parseInt(flagString(args, 'limit') ?? '5', 10);
  const includeGlob = flagString(args, 'include');

  const inspection = await inspectSharkcraft({ cwd });
  const patterns = await loadScaffoldPatternsFromInspection(inspection);

  // Walk candidate files: when scaffold patterns exist, use their match paths
  // as the seed set; otherwise scan src/ for files matching the kind.
  const candidates = collectCandidateFiles({
    cwd,
    inspection,
    patterns: patterns.patterns,
    kind,
    includeGlob,
  });
  if (candidates.length === 0) {
    if (wantJson) {
      process.stdout.write(asJson({ candidates: [], note: 'no candidate files found' }) + '\n');
    } else {
      process.stdout.write('No candidate files found.\n');
    }
    return 0;
  }

  const out: ICandidateV2[] = [];
  for (const c of candidates.slice(0, Math.max(1, limit))) {
    const relPath = nodePath.relative(cwd, c.absPath).split(nodePath.sep).join('/');
    const candidate: ICandidateV2 = {
      schema: 'sharkcraft.inferred-template-candidate/v2',
      sample: relPath,
      variables: {},
      warnings: [],
    };
    // Scaffold-pattern match (if any).
    if (c.pattern) {
      const ext = extractVariablesForFile(c.pattern.pattern, relPath, inspection);
      candidate.matchedPattern = {
        id: c.pattern.pattern.id,
        templateId: c.pattern.pattern.templateId,
        source: c.pattern.source.packageName ?? c.pattern.source.type,
        confidence: c.pattern.pattern.confidence,
      };
      candidate.variables = ext.values;
      candidate.warnings.push(...ext.warnings);
      candidate.suggestedCommand = buildSuggestedCommand(c.pattern.pattern.templateId, ext.values);
    }
    if (useAst) {
      const v2 = await inferTemplateBodyV2({
        projectRoot: cwd,
        sample: relPath,
        kind,
      });
      if (v2.scaffold) candidate.scaffold = v2.scaffold;
      else if (v2.reason) candidate.warnings.push(v2.reason);
    }
    out.push(candidate);
  }

  if (wantJson) {
    process.stdout.write(
      asJson({
        candidates: out,
        scaffoldPatternsConsidered: patterns.patterns.length,
        warnings: patterns.warnings,
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(header(`Template inference (${useAst ? 'ast' : 'pattern-only'})`));
  for (const c of out) {
    process.stdout.write(`\n  sample      ${c.sample}\n`);
    if (c.matchedPattern) {
      process.stdout.write(
        `  pattern     ${c.matchedPattern.id}  → ${c.matchedPattern.templateId} (${c.matchedPattern.confidence}, from ${c.matchedPattern.source})\n`,
      );
    }
    if (Object.keys(c.variables).length > 0) {
      process.stdout.write(`  vars        ${Object.entries(c.variables).map(([k, v]) => `${k}=${v}`).join(', ')}\n`);
    }
    if (c.scaffold) {
      process.stdout.write(`  ast         ${c.scaffold.provenance}  (confidence=${c.scaffold.confidence})\n`);
      for (const r of c.scaffold.confidenceReasons.slice(0, 2)) process.stdout.write(`              · ${r}\n`);
    }
    if (c.suggestedCommand) process.stdout.write(`  suggested   ${c.suggestedCommand}\n`);
    for (const w of c.warnings.slice(0, 2)) process.stdout.write(`  warn        ${w}\n`);
  }
  return 0;
}

interface ICandidate {
  absPath: string;
  pattern?: IScaffoldPatternWithSource;
}

interface ICollectInput {
  cwd: string;
  inspection: ISharkcraftInspection;
  patterns: readonly IScaffoldPatternWithSource[];
  kind: 'service' | 'utility' | 'test' | 'component';
  includeGlob?: string | undefined;
}

function collectCandidateFiles(input: ICollectInput): ICandidate[] {
  const seen = new Map<string, ICandidate>();
  // 1. Scaffold-pattern matches.
  if (input.patterns.length > 0) {
    walk(input.cwd, (abs, rel) => {
      for (const p of input.patterns) {
        if (matchScaffoldPattern(p.pattern, rel)) {
          if (!seen.has(abs)) seen.set(abs, { absPath: abs, pattern: p });
          return;
        }
      }
    });
  }
  // 2. Generic kind-based scan if there are no matches yet.
  if (seen.size === 0) {
    const dirToken = kindToDir(input.kind);
    walk(input.cwd, (abs, rel) => {
      if (rel.includes(`/${dirToken}/`) && /\.(tsx?|jsx?)$/.test(abs)) {
        if (!seen.has(abs)) seen.set(abs, { absPath: abs });
      }
    });
  }
  let out = [...seen.values()];
  if (input.includeGlob) {
    const re = globRe(input.includeGlob);
    out = out.filter((c) => re.test(nodePath.relative(input.cwd, c.absPath).split(nodePath.sep).join('/')));
  }
  return out;
}

function kindToDir(kind: 'service' | 'utility' | 'test' | 'component'): string {
  switch (kind) {
    case 'service':
      return 'services';
    case 'utility':
      return 'utils';
    case 'test':
      return 'tests';
    case 'component':
      return 'components';
  }
}

function walk(root: string, onFile: (abs: string, rel: string) => void): void {
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.sharkcraft' || e === '__tests__') continue;
      const full = nodePath.join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) {
        const rel = nodePath.relative(root, full).split(nodePath.sep).join('/');
        onFile(full, rel);
      }
    }
  };
  if (existsSync(root)) visit(root);
}

function globRe(g: string): RegExp {
  let re = '^';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if ('.+()[]{}|^$\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  re += '$';
  return new RegExp(re);
}

function buildSuggestedCommand(templateId: string, vars: Record<string, string>): string {
  const name = vars.name ?? '<name>';
  const flags = Object.entries(vars)
    .filter(([k]) => k !== 'name')
    .map(([k, v]) => `--var ${k}=${v}`)
    .join(' ');
  return `shrk gen ${templateId} ${name}${flags ? ' ' + flags : ''} --dry-run --save-plan /tmp/${templateId}.plan.json`;
}
