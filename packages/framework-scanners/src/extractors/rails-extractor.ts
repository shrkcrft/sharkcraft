import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const RAILS_EXTRACTOR_SOURCE = 'rails-extractor@v1';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'match']);

const FAST_FILTER_NEEDLES = [
  'ApplicationController',
  'ActionController::',
  'ApplicationRecord',
  'ActiveRecord::Base',
  'Rails.application.routes.draw',
  'resources :',
  'resource :',
];

/**
 * Rails extractor.
 *
 * Regex-only. Detection model:
 *
 *   - **Controllers**: `class Name < ApplicationController` (or
 *     `ActionController::Base`). Action methods are public `def`s
 *     declared inside; we capture the controller as a single entity
 *     plus one `route`-style action entity per `def`.
 *   - **Models**: `class Name < ApplicationRecord` (or
 *     `ActiveRecord::Base`) → model entity.
 *   - **Routes**: any file named `routes.rb` is parsed for top-level
 *     `resources :name`, `resource :name`, `get '...' => '...'`, and
 *     bare `get '...'`. Each emits a route entity.
 *
 * Out of scope:
 *   - `namespace :foo do ... end` nesting (we don't merge the prefix
 *     into nested route paths).
 *   - Before-action filters / authorization DSLs.
 *   - Concerns / mixins.
 */
export const railsExtractor: IFrameworkExtractor = {
  framework: 'rails',
  label: 'Rails',
  fileMatches({ path, content }) {
    if (!path.endsWith('.rb')) return false;
    if (/(?:^|\/)routes\.rb$/.test(path)) return true;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const lines = input.content.split('\n');

    // Controllers + models walk class declarations.
    let currentControllerEntity: INode | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      // Controller
      let m = /^class\s+([A-Z][\w]*)\s*<\s*(?:ApplicationController|ActionController::[A-Za-z]+)/.exec(raw);
      if (m) {
        const e = makeEntity(input, 'controller', m[1]!, { className: m[1]! });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'controller', line: i + 1 }));
        currentControllerEntity = e;
        continue;
      }
      // Model
      m = /^class\s+([A-Z][\w]*)\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)/.exec(raw);
      if (m) {
        const e = makeEntity(input, 'model', m[1]!, { className: m[1]! });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'model', line: i + 1 }));
        continue;
      }
      // Controller actions (public def inside a controller body).
      m = /^\s+def\s+([a-z_][\w?!]*)/.exec(raw);
      if (m && currentControllerEntity) {
        const action = m[1]!;
        // Skip private rails internals.
        if (action.startsWith('_')) continue;
        const e = makeEntity(input, 'action', action, {
          controller: currentControllerEntity.label,
          action,
        });
        nodes.push(e);
        edges.push(edge(currentControllerEntity.id, e.id, EdgeKind.HandlesRoute, {
          action,
          controller: currentControllerEntity.label,
        }));
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'action', line: i + 1 }));
      }
      // `end` at column 0 closes the controller. Heuristic; works for
      // typical Rails one-class-per-file convention.
      if (/^end\s*$/.test(raw.trimEnd())) {
        currentControllerEntity = undefined;
      }
    }

    // Routes (only in routes.rb).
    if (/(?:^|\/)routes\.rb$/.test(input.filePath)) {
      // Stack of `namespace :v1 do ... end` prefixes. Each entry is
      // the symbol name (without leading colon), pushed on
      // `namespace :foo do` and popped on the matching `end`.
      const namespaceStack: string[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i]!.trim();
        if (!raw || raw.startsWith('#')) continue;
        // namespace :foo do  → push
        const nsMatch = /^namespace\s+:([a-z_]\w*)\s+do\b/.exec(raw);
        if (nsMatch) {
          namespaceStack.push(nsMatch[1]!);
          continue;
        }
        // `end` line closes the nearest namespace.
        if (/^end\b/.test(raw) && namespaceStack.length > 0) {
          namespaceStack.pop();
          continue;
        }
        const prefix = namespaceStack.length > 0 ? '/' + namespaceStack.join('/') : '';
        let m = /^resources\s+:([a-z_]\w*)/.exec(raw);
        if (m) {
          const r = makeRouteEntity(input, m[1]!, 'RESOURCES', `${prefix}/${m[1]!}`, 'index');
          nodes.push(r);
          edges.push(edge(input.fileNodeId, r.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
          continue;
        }
        m = /^resource\s+:([a-z_]\w*)/.exec(raw);
        if (m) {
          const r = makeRouteEntity(input, m[1]!, 'RESOURCE', `${prefix}/${m[1]!}`, 'show');
          nodes.push(r);
          edges.push(edge(input.fileNodeId, r.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
          continue;
        }
        // `get '/path' => 'controller#action'` OR `get '/path', to: 'controller#action'`
        m = /^(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"](?:\s*(?:=>|,\s*to:)\s*['"]([^'"]+)['"])?/.exec(raw);
        if (m && HTTP_VERBS.has(m[1]!)) {
          const verb = m[1]!.toUpperCase();
          const leaf = m[2]!;
          const path = prefix ? `${prefix}${leaf.startsWith('/') ? '' : '/'}${leaf}` : leaf;
          const target = m[3] ?? '';
          const r = makeRouteEntity(input, 'routes', verb, path, target);
          nodes.push(r);
          edges.push(edge(input.fileNodeId, r.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
        }
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
    id: `framework:rails:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['rails', subtype],
    data: { framework: 'rails', subtype, ...extra },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  scope: string,
  method: string,
  path: string,
  target: string,
): INode {
  const id = `framework:rails:route:${input.filePath}#${scope}#${method}:${path}#${target}`;
  return {
    id,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path}${target ? ` → ${target}` : ''}`,
    path: input.filePath,
    tags: ['rails', 'route'],
    data: { framework: 'rails', subtype: 'route', method, path, target, scope },
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
    source: RAILS_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
