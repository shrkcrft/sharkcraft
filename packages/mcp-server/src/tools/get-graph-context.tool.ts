import {
  GraphQueryApi,
  GraphStore,
  NodeKind,
  loadGraphApiCached,
  type INode,
} from '@shrkcrft/graph';
import type { IToolDefinition } from '../server/tool-definition.ts';
import { FORMAT_INPUT_PROPERTY, formatObjectArrays } from '../server/columnar-format.ts';
import { dropDeleted, graphResultStaleness } from './graph-staleness.ts';

const NEXT = 'shrk graph index';

interface IContextInput {
  target?: string;
}

export const getGraphContextTool: IToolDefinition = {
  name: 'get_graph_context',
  description:
    'Return graph context for a file or symbol: declared symbols, files this imports, files that import it. Read-only.',
  cliCommand: 'graph context',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' }, ...FORMAT_INPUT_PROPERTY },
    required: ['target'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const args = input as IContextInput;
    const target = (args.target ?? '').trim();
    if (!target) {
      return {
        isError: true,
        error: { code: 'invalid-input', message: 'target is required' },
      };
    }
    const store = new GraphStore(ctx.inspection.projectRoot);
    if (!store.exists()) {
      return {
        isError: true,
        error: {
          code: 'graph-missing',
          message: `Code-intelligence index is missing. Run '${NEXT}'.`,
          details: { nextCommand: NEXT },
        },
      };
    }
    const api = loadGraphApiCached(ctx.inspection.projectRoot) ?? GraphQueryApi.fromStore(ctx.inspection.projectRoot);
    const anchor = resolveAnchor(api, target);
    if (!anchor) {
      return {
        isError: true,
        error: {
          code: 'not-found',
          message: `No graph node matched "${target}".`,
          details: { target },
        },
      };
    }
    // A SYMBOL has no imports-file edges (those are file→file), so its import
    // context is the DECLARING FILE's imports — compute neighbours on that file
    // (mirrors the CLI; otherwise importsFrom/importedBy are wrongly empty).
    const declaringFile =
      anchor.kind === NodeKind.Symbol
        ? api.declaringFileOf(anchor.id) ?? (anchor.path ? api.findFile(anchor.path) : undefined)
        : undefined;
    const subjectId = anchor.kind === NodeKind.File ? anchor.id : declaringFile?.id ?? anchor.id;
    const neighbours = api.neighbours(subjectId)!;
    const symbols = anchor.kind === NodeKind.File ? api.symbolsIn(anchor.id) : [];
    // Who uses this symbol — references + calls (the CLI provides these; the MCP
    // previously omitted them, returning a confidently-wrong "nothing uses this").
    const referencedBy = anchor.kind === NodeKind.Symbol ? api.referencesOf(anchor.id) : [];
    const calledBy = anchor.kind === NodeKind.Symbol ? api.callersOf(anchor.id) : [];
    // Typed subtype/supertype edges (extends / implements) — the precise
    // "who implements this interface" answer for a symbol anchor.
    const subtypes = anchor.kind === NodeKind.Symbol ? api.subtypesOf(anchor.id) : [];
    const supertypes = anchor.kind === NodeKind.Symbol ? api.supertypesOf(anchor.id) : [];
    const importsFrom = neighbours.out
      .filter((o) => o.edge.kind === 'imports-file')
      .slice(0, 50)
      .map((o) =>
        'resolved' in o.target
          ? { id: o.target.id, resolved: false }
          : { ...summarise(o.target), resolved: true },
      );
    const importedBy = neighbours.in
      .filter((i) => i.edge.kind === 'imports-file')
      .slice(0, 50)
      .map((i) =>
        'resolved' in i.source
          ? { id: i.source.id, resolved: false }
          : { ...summarise(i.source), resolved: true },
      );
    const referencedByRows = referencedBy.slice(0, 50).map(summarise);
    const calledByRows = calledBy.slice(0, 50).map(summarise);
    // Drop imports/refs to/from files deleted on disk; flag the rest if changed.
    const fresh = graphResultStaleness(api, ctx.inspection.projectRoot, [
      anchor.path,
      ...importsFrom.map((x) => ('path' in x ? x.path : undefined)),
      ...importedBy.map((x) => ('path' in x ? x.path : undefined)),
      ...referencedByRows.map((x) => x.path),
      ...calledByRows.map((x) => x.path),
    ]);
    const data = {
      schema: 'sharkcraft.graph-context/v1',
      anchor: summarise(anchor),
      ...(declaringFile ? { declaredIn: summarise(declaringFile) } : {}),
      importsFrom: dropDeleted(importsFrom, fresh.deletedSet),
      importedBy: dropDeleted(importedBy, fresh.deletedSet),
      symbols: symbols.slice(0, 50).map(summarise),
      ...(referencedByRows.length > 0 ? { referencedBy: dropDeleted(referencedByRows, fresh.deletedSet) } : {}),
      ...(calledByRows.length > 0 ? { calledBy: dropDeleted(calledByRows, fresh.deletedSet) } : {}),
      ...(subtypes.length > 0 ? { subtypes: subtypes.slice(0, 50).map(summarise) } : {}),
      ...(supertypes.length > 0 ? { supertypes: supertypes.slice(0, 50).map(summarise) } : {}),
      ...(fresh.field ?? {}),
    };
    return { data: formatObjectArrays(data, input) };
  },
};

function resolveAnchor(api: GraphQueryApi, target: string): INode | undefined {
  const direct = api.neighbours(target);
  if (direct) return direct.node;
  if (target.startsWith('file:') || target.startsWith('symbol:') || target.startsWith('package:')) {
    return undefined;
  }
  const f = api.findFile(target);
  if (f) return f;
  const syms = api.findSymbol(target, { exact: true, limit: 1 });
  if (syms.length > 0) return syms[0];
  return undefined;
}

function summarise(n: INode): {
  id: string;
  kind: string;
  label: string;
  path?: string;
  line?: number;
} {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    ...(n.path ? { path: n.path } : {}),
    ...(n.line ? { line: n.line } : {}),
  };
}
