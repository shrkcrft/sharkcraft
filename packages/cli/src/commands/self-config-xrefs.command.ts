/**
 * `shrk self-config resolve <id>` and `shrk self-config xrefs` — the lookup and
 * listing verbs over THE declared cross-reference collector.
 *
 * Ids carry no namespace prefix, so "is this `related` id live, and what is
 * it?" used to mean grepping several asset sources in turn. `resolve` answers
 * it for one id: every registry that has it (most specific first, with the verb
 * that shows it) and every declared field pointing at it. `xrefs` prints the
 * extracted set — the contract `gates explain` honours for gate rules. Both are
 * thin renderers: the answers come from `buildDeclaredXrefReport` and the
 * reference registry, never from a walk of their own.
 */
import {
  ALL_ID_REFERENCE_KINDS,
  buildDeclaredXrefReport,
  DECLARED_XREF_FIELDS,
  declaredXrefSummaryLine,
  DeclaredXrefStatus,
  inspectSharkcraft,
  isBrokenXref,
  nearestIds,
  referenceIdPool,
  referenceKindsOf,
  reverseXrefs,
  type IDeclaredXrefRow,
  type ReferenceKind,
} from '@shrkcrft/inspector';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { ExitCode } from '../exit-codes.ts';
import { asJson, header } from '../output/format-output.ts';

/**
 * The verb that shows an id of each kind. Every entry must resolve through the
 * live command index (`r75-xrefs-cli.test.ts` locks it), so a renamed verb
 * fails the day it is renamed instead of being printed as a dead command. A
 * kind with no show / list verb is absent — never guessed.
 */
export const REFERENCE_KIND_VERBS: Readonly<Partial<Record<ReferenceKind, string>>> = Object.freeze({
  template: 'shrk templates get <id>',
  pipeline: 'shrk pipelines get <id>',
  playbook: 'shrk playbooks get <id>',
  policy: 'shrk policy get <id>',
  construct: 'shrk constructs get <id>',
  helper: 'shrk helper get <id>',
  'boundary-rule': 'shrk boundaries list',
  'path-convention': 'shrk paths get <id>',
  rule: 'shrk rules get <id>',
  knowledge: 'shrk knowledge get <id>',
  convention: 'shrk conventions get <id>',
  'migration-profile': 'shrk profiles get <id>',
  'registration-hint': 'shrk registrations get <id>',
  'scaffold-pattern': 'shrk scaffolds get <id>',
} satisfies Partial<Record<ReferenceKind, string>>);

function verbFor(kind: ReferenceKind, id: string): string | undefined {
  return REFERENCE_KIND_VERBS[kind]?.replace('<id>', id);
}

function rowLabel(r: IDeclaredXrefRow): string {
  return `${r.sourceKind}:${r.sourceId} ${r.field}${r.facetId ? ` [${r.facetId}]` : ''}`;
}

function statusText(r: IDeclaredXrefRow): string {
  switch (r.status) {
    case DeclaredXrefStatus.Ok:
      return `→ ${r.resolvedAs.join(' | ')}`;
    case DeclaredXrefStatus.Dangling:
      return `UNRESOLVED — no registry has this id${r.didYouMean.length > 0 ? ` (did you mean "${r.didYouMean[0]}"?)` : ''}`;
    case DeclaredXrefStatus.WrongKind:
      return `WRONG KIND — resolves as ${r.resolvedAs.join(' | ')}; the field accepts ${r.accepts === 'any' ? 'any kind' : r.accepts.join(' | ')}`;
    default:
      return 'NOT VERIFIED — its registry was not warmed, or is empty';
  }
}

export const selfConfigResolveCommand: ICommandHandler = {
  name: 'resolve',
  description:
    'Which registry an id resolves in — every kind, most specific first, with the verb that shows it — and every declared cross-reference pointing at it; did-you-mean when it resolves nowhere. Exit 0 resolved · 1 unresolved · 3 no id.',
  usage: 'shrk self-config resolve <id> [--json]',
  booleanFlags: new Set(['json']),
  async run(args: ParsedArgs): Promise<number> {
    const id = args.positional[0];
    if (!id) {
      process.stderr.write('Usage: shrk self-config resolve <id> [--json]\n');
      return ExitCode.UsageError;
    }
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    // Warms every registry, so a construct / playbook id resolves like any other.
    const report = await buildDeclaredXrefReport(inspection);
    const kinds = referenceKindsOf(inspection, id);
    const pointedAtBy = reverseXrefs(report, id);
    const didYouMean =
      kinds.length === 0 ? nearestIds(id, referenceIdPool(inspection, ALL_ID_REFERENCE_KINDS)).map((n) => n.id) : [];
    const exit = kinds.length > 0 ? ExitCode.VerifiedPass : ExitCode.Failure;
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          id,
          resolved: kinds.length > 0,
          resolvedAs: kinds.map((kind) => ({ kind, ...(verbFor(kind, id) ? { verb: verbFor(kind, id) } : {}) })),
          pointedAtBy: pointedAtBy.map((r) => ({
            sourceKind: r.sourceKind,
            sourceId: r.sourceId,
            field: r.field,
            ...(r.facetId ? { facetId: r.facetId } : {}),
            status: r.status,
            ...(r.file ? { file: r.file } : {}),
          })),
          didYouMean,
          exitCode: exit,
        }) + '\n',
      );
      return exit;
    }
    process.stdout.write(header(`Resolve: ${id}`));
    if (kinds.length > 0) {
      process.stdout.write('  resolves as (most specific first):\n');
      for (const kind of kinds) {
        const verb = verbFor(kind, id);
        process.stdout.write(`    • ${kind.padEnd(18)}${verb ? `  ${verb}` : ''}\n`);
      }
    } else {
      process.stdout.write(`  UNRESOLVED — no registry has "${id}" (checked ${ALL_ID_REFERENCE_KINDS.length} kinds).\n`);
      if (didYouMean.length > 0) process.stdout.write(`  did you mean: ${didYouMean.join(', ')}\n`);
    }
    process.stdout.write(`\n  pointed at by (${pointedAtBy.length}):\n`);
    if (pointedAtBy.length === 0) process.stdout.write('    (no declared cross-reference names it)\n');
    for (const r of pointedAtBy) {
      process.stdout.write(
        `    • ${rowLabel(r)}${r.status === DeclaredXrefStatus.Ok ? '' : `  (${r.status})`}${r.file ? `  — ${r.file}` : ''}\n`,
      );
    }
    return exit;
  },
};

/** The source kinds the collector walks — the only valid `--source <kind>:` prefixes. */
const SOURCE_KINDS: readonly string[] = [...new Set(DECLARED_XREF_FIELDS.map((f) => f.sourceKind))];

export const selfConfigXrefsCommand: ICommandHandler = {
  name: 'xrefs',
  description:
    'Every declared cross-reference id — knowledge related / seeAlso / supersededBy / action hints, construct related* + facets that declare resolvesAs, boundary related*, template related — with the namespace(s) it resolved into and its status. `--source <kind>:<id>` narrows to one asset, `--dangling-only` keeps the broken ones. Exit 0 (a listing); 3 on a malformed --source.',
  usage: 'shrk self-config xrefs [--source <kind>:<id>] [--dangling-only] [--json]',
  booleanFlags: new Set(['json', 'dangling-only']),
  async run(args: ParsedArgs): Promise<number> {
    let source: { kind: string; id: string } | undefined;
    if (args.flags.has('source')) {
      const raw = flagString(args, 'source') ?? '';
      const at = raw.indexOf(':');
      const kind = at > 0 ? raw.slice(0, at) : '';
      const id = at > 0 ? raw.slice(at + 1) : '';
      if (!kind || !id || !SOURCE_KINDS.includes(kind)) {
        process.stderr.write(
          `--source must be <kind>:<id> with <kind> one of: ${SOURCE_KINDS.join(', ')} (got "${raw}").\n`,
        );
        return ExitCode.UsageError;
      }
      source = { kind, id };
    }
    const danglingOnly = flagBool(args, 'dangling-only');
    const inspection = await inspectSharkcraft({ cwd: resolveCwd(args) });
    const report = await buildDeclaredXrefReport(inspection);
    const inScope = (r: { sourceKind: string; sourceId: string }): boolean =>
      !source || (r.sourceKind === source.kind && r.sourceId === source.id);
    const rows = report.rows.filter((r) => inScope(r) && (!danglingOnly || isBrokenXref(r)));
    const issues = report.issues.filter(inScope);
    if (flagBool(args, 'json')) {
      process.stdout.write(
        asJson({
          schema: report.schema,
          ...(source ? { source: `${source.kind}:${source.id}` } : {}),
          danglingOnly,
          shown: rows.length,
          counts: report.counts,
          examined: report.examined,
          rows,
          issues,
        }) + '\n',
      );
      return ExitCode.VerifiedPass;
    }
    const scope = source ? ` — ${source.kind}:${source.id}` : '';
    process.stdout.write(header(`Declared cross-references${scope} (${rows.length})`));
    process.stdout.write(`  ${declaredXrefSummaryLine(report)}\n\n`);
    if (rows.length === 0) {
      process.stdout.write(
        `  (${danglingOnly ? 'no dangling or wrong-kind id' : 'no declared cross-reference id'}${source ? ' on this asset' : ''})\n`,
      );
    }
    for (const r of rows) {
      process.stdout.write(`  • ${rowLabel(r)} → ${r.targetId}  ${statusText(r)}\n`);
    }
    if (issues.length > 0) {
      process.stdout.write(`\n  declaration issues (${issues.length}):\n`);
      for (const i of issues) process.stdout.write(`    ${i.severity.padEnd(7)} [${i.code}] ${i.message}\n`);
    }
    return ExitCode.VerifiedPass;
  },
};
