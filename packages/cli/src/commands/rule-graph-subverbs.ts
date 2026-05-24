/**
 * CLI subverbs for `@shrkcrft/rule-graph`.
 *
 * Sub-namespace: `shrk rule-graph <verb>`. Lives in its own command
 * because the verbs operate on a separate `.sharkcraft/bridge/` store
 * and don't conceptually belong under `shrk graph`.
 */
import { buildBridge, RuleGraphQueryApi } from '@shrkcrft/rule-graph';
import { flagBool, resolveCwd, type ICommandHandler, type ParsedArgs } from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';

export const ruleGraphCommand: ICommandHandler = {
  name: 'rule-graph',
  description:
    'Bridge the SharkCraft code graph to asset registries (boundary rules, path conventions, templates). Sub-verbs: index, status, for <file>.',
  usage:
    'shrk rule-graph index [--json] | shrk rule-graph status [--json] | shrk rule-graph for <file> [--json]',
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'index') return runIndex(args);
    if (sub === 'status') return runStatus(args);
    if (sub === 'for') return runFor(args);
    process.stderr.write(this.usage + '\n');
    return 2;
  },
};

async function runIndex(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const r = await buildBridge({ projectRoot: cwd });
  if (wantJson) {
    process.stdout.write(asJson({ ok: true, manifest: r.manifest, durationMs: r.durationMs }) + '\n');
    return 0;
  }
  process.stdout.write(header('Rule-graph bridge'));
  process.stdout.write(kv('schema', r.manifest.schema) + '\n');
  process.stdout.write(kv('bridge edges', String(sumValues(r.manifest.edgesByKind))) + '\n');
  process.stdout.write(kv('rules → files', String(r.manifest.sourceCounts['rule'] ?? 0)) + '\n');
  process.stdout.write(kv('paths → files', String(r.manifest.sourceCounts['path'] ?? 0)) + '\n');
  process.stdout.write(kv('templates → files', String(r.manifest.sourceCounts['template'] ?? 0)) + '\n');
  process.stdout.write(kv('duration', `${r.durationMs}ms`) + '\n');
  return 0;
}

async function runStatus(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const missing = RuleGraphQueryApi.missingDescription(cwd);
  if (missing) {
    if (wantJson) {
      process.stdout.write(
        asJson({ ok: false, state: 'missing', message: missing, nextCommand: 'shrk rule-graph index' }) + '\n',
      );
      return 1;
    }
    process.stderr.write(missing + '\n');
    return 1;
  }
  const api = RuleGraphQueryApi.fromStores(cwd);
  // No public counters from the API itself — just confirm it loads.
  if (wantJson) {
    process.stdout.write(asJson({ ok: true, state: 'fresh' }) + '\n');
    return 0;
  }
  process.stdout.write(header('Rule-graph status'));
  process.stdout.write(kv('state', 'fresh') + '\n');
  void api;
  return 0;
}

async function runFor(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const file = args.positional[1];
  if (!file) {
    process.stderr.write('Usage: shrk rule-graph for <file>\n');
    return 2;
  }
  const missing = RuleGraphQueryApi.missingDescription(cwd);
  if (missing) {
    if (wantJson) {
      process.stdout.write(
        asJson({ ok: false, message: missing, nextCommand: 'shrk rule-graph index' }) + '\n',
      );
      return 1;
    }
    process.stderr.write(missing + '\n');
    return 1;
  }
  const api = RuleGraphQueryApi.fromStores(cwd);
  const r = api.forFile(file);
  if (!r) {
    const payload = { ok: false, error: 'not-found', file };
    if (wantJson) {
      process.stdout.write(asJson(payload) + '\n');
      return 1;
    }
    process.stderr.write(`No file node for "${file}".\n`);
    return 1;
  }
  const payload = {
    schema: 'sharkcraft.rule-graph-for-file/v1',
    file: r.path,
    rules: r.rules.map((h) => ({ id: h.target.id, label: h.target.label, severity: (h.edge.data?.['severity'] as string) ?? undefined })),
    paths: r.paths.map((h) => ({ id: h.target.id, label: h.target.label })),
    templates: r.templates.map((h) => ({ id: h.target.id, label: h.target.label })),
  };
  if (wantJson) {
    process.stdout.write(asJson(payload) + '\n');
    return 0;
  }
  process.stdout.write(header(`Rule-graph for: ${r.path}`));
  if (payload.rules.length > 0) {
    process.stdout.write('\nRules (boundary):\n');
    for (const h of payload.rules) process.stdout.write(`  ${h.id} — ${h.label}${h.severity ? ' [' + h.severity + ']' : ''}\n`);
  }
  if (payload.paths.length > 0) {
    process.stdout.write('\nPath conventions:\n');
    for (const h of payload.paths) process.stdout.write(`  ${h.id} — ${h.label}\n`);
  }
  if (payload.templates.length > 0) {
    process.stdout.write('\nTemplates:\n');
    for (const h of payload.templates) process.stdout.write(`  ${h.id} — ${h.label}\n`);
  }
  if (payload.rules.length === 0 && payload.paths.length === 0 && payload.templates.length === 0) {
    process.stdout.write('  (no bridge edges for this file)\n');
  }
  return 0;
}

function sumValues(record: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(record)) n += v;
  return n;
}
