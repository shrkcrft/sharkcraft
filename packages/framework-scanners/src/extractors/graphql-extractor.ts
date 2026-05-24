import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const GRAPHQL_EXTRACTOR_SOURCE = 'graphql-extractor@v1';

const ROOT_TYPE_NAMES = new Set(['Query', 'Mutation', 'Subscription']);

/**
 * GraphQL schema extractor.
 *
 * Parses `.graphql` / `.gql` SDL files. Detected:
 *   - `type Name { … }`             → type
 *   - `interface Name { … }`         → interface
 *   - `enum Name { … }`              → enum
 *   - `input Name { … }`             → input
 *   - `union Name = A | B`           → union
 *   - `scalar Name`                  → scalar
 *   - `directive @name on …`         → directive
 *
 * The three root types — `Query`, `Mutation`, `Subscription` — get one
 * extra **field** entity per declared field. Each is wired back to the
 * parent type via `HandlesRoute` so the dashboard's Routes panel can
 * surface GraphQL operations alongside HTTP routes.
 *
 * Out of scope:
 *   - `schema { query: ..., mutation: ... }` aliasing.
 *   - `extend type X { … }` (the extender re-declares).
 *   - Field arguments / nested complex types.
 *   - GraphQL-in-strings (e.g. JS `gql\`type Foo { ... }\``).
 */
export const graphqlExtractor: IFrameworkExtractor = {
  framework: 'graphql',
  label: 'GraphQL',
  fileMatches({ path }) {
    return path.endsWith('.graphql') || path.endsWith('.gql');
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const lines = input.content.split('\n');

    // Walk line by line, tracking the open root-type block (so each
    // line inside it can be parsed as a field). Comments (`#`) are
    // stripped.
    let currentRootType: INode | undefined;
    let currentRootKind: string | undefined;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      const trimmed = raw.replace(/#.*$/, '').trim();
      if (!trimmed) continue;

      // Track brace depth to know when we exit a block.
      // (We open the block on the same line as the declaration and
      // close it when '}' appears.)
      if (currentRootType && trimmed.includes('}')) {
        braceDepth -= (trimmed.match(/\}/g) ?? []).length;
        if (braceDepth <= 0) {
          currentRootType = undefined;
          currentRootKind = undefined;
          braceDepth = 0;
        }
      }

      // Type-shape declarations.
      let m = /^(type|interface|enum|input|union|scalar|directive)\s+(@?[A-Za-z_][\w]*)/.exec(trimmed);
      if (m) {
        const kind = m[1]!;
        const rawName = m[2]!;
        const name = rawName.startsWith('@') ? rawName.slice(1) : rawName;
        const entity = makeEntity(input, kind, name, { kind, name });
        nodes.push(entity);
        edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: kind, line: i + 1 }));
        // Open a root-type block when the declaration opens with `{`.
        if ((kind === 'type' || kind === 'interface') && trimmed.includes('{')) {
          braceDepth += (trimmed.match(/\{/g) ?? []).length;
          braceDepth -= (trimmed.match(/\}/g) ?? []).length;
          if (ROOT_TYPE_NAMES.has(name)) {
            currentRootType = entity;
            currentRootKind = name;
          }
        }
        continue;
      }

      // Inside a Query / Mutation / Subscription block — capture fields.
      if (currentRootType && currentRootKind) {
        const fieldMatch = /^([A-Za-z_][\w]*)\s*(?:\(([^)]*)\))?\s*:\s*([\w\[\]!]+)/.exec(trimmed);
        if (fieldMatch) {
          const fieldName = fieldMatch[1]!;
          const argString = fieldMatch[2] ?? '';
          const returnType = fieldMatch[3]!;
          const fieldEntity = makeFieldEntity(input, currentRootKind, fieldName, returnType, argString);
          nodes.push(fieldEntity);
          edges.push(edge(currentRootType.id, fieldEntity.id, EdgeKind.HandlesRoute, {
            operation: currentRootKind.toLowerCase(),
            field: fieldName,
          }));
          edges.push(edge(input.fileNodeId, fieldEntity.id, EdgeKind.FrameworkDeclares, {
            subtype: 'operation',
            line: i + 1,
          }));
        }
        // Continue tracking brace depth for nested blocks.
        braceDepth += (trimmed.match(/\{/g) ?? []).length;
      }
    }

    return { nodes, edges };
  },
};

function makeEntity(
  input: IExtractInput,
  subtype: string,
  label: string,
  extra: Readonly<Record<string, unknown>>,
): INode {
  return {
    id: `framework:graphql:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['graphql', subtype],
    data: { framework: 'graphql', subtype, ...extra },
  };
}

function makeFieldEntity(
  input: IExtractInput,
  rootKind: string,
  fieldName: string,
  returnType: string,
  args: string,
): INode {
  return {
    id: `framework:graphql:operation:${input.filePath}#${rootKind}.${fieldName}`,
    kind: NodeKind.FrameworkEntity,
    label: `${rootKind.toLowerCase()} ${fieldName}`,
    path: input.filePath,
    tags: ['graphql', 'operation', rootKind.toLowerCase()],
    data: {
      framework: 'graphql',
      subtype: 'operation',
      operation: rootKind.toLowerCase(),
      field: fieldName,
      returnType,
      ...(args ? { args } : {}),
    },
  };
}

function edge(
  from: string,
  to: string,
  kind: EdgeKind,
  data?: Readonly<Record<string, unknown>>,
): IEdge {
  return {
    id: createHash('sha1').update(`${from}|${to}|${kind}`).digest('hex'),
    from,
    to,
    kind,
    source: GRAPHQL_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
