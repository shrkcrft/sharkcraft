import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const PHOENIX_EXTRACTOR_SOURCE = 'phoenix-extractor@v1';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

const FAST_FILTER_NEEDLES = [
  'use Phoenix.Controller',
  'use Phoenix.Router',
  'use Phoenix.LiveView',
  'use Phoenix.LiveComponent',
  'use Ecto.Schema',
  ':controller',
  ':router',
];

/**
 * Phoenix extractor.
 *
 * Regex-only. Detection:
 *
 *   - **Controller**: `defmodule X do` followed by
 *     `use AppWeb, :controller` OR `use Phoenix.Controller` →
 *     controller entity. Public `def action(conn, params)` inside →
 *     action entities.
 *
 *   - **Router**: any module with `use Phoenix.Router` (or
 *     `use AppWeb, :router`). Parses top-level `get|post|...
 *     "/path", Controller, :action` lines → route entities.
 *
 *   - **Schema**: `use Ecto.Schema` → schema entity (subtype: model).
 *
 *   - **LiveView / LiveComponent**: `use Phoenix.LiveView` /
 *     `use Phoenix.LiveComponent` → component entity.
 *
 * Out of scope:
 *   - `pipeline :foo do ... end` aggregations.
 *   - `scope "/path", AppWeb do ... end` prefix nesting.
 *   - Channel modules.
 */
export const phoenixExtractor: IFrameworkExtractor = {
  framework: 'phoenix',
  label: 'Phoenix',
  fileMatches({ path, content }) {
    if (!path.endsWith('.ex') && !path.endsWith('.exs')) return false;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const lines = input.content.split('\n');

    // Discover the current module + its kind (controller / router / live / schema).
    let currentModuleName: string | undefined;
    let currentEntity: INode | undefined;
    let currentKind: 'controller' | 'router' | 'live-view' | 'live-component' | 'schema' | undefined;

    // Stack of `scope "/prefix", AppWeb do … end` prefixes — only used
    // inside a router module. Each `scope` line pushes; each `end`
    // line at the matching depth pops.
    const scopeStack: string[] = [];
    // Parallel stack for the optional module argument
    // (`scope "/api", AppWeb do`). When set, the captured controller
    // name is prefixed with this module. Empty string when the scope
    // had no module argument (i.e. only a path prefix).
    const scopeModuleStack: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      const trimmed = raw.trimStart();
      const defm = /^defmodule\s+([A-Z][\w.]*)\s+do/.exec(trimmed);
      if (defm) {
        currentModuleName = defm[1]!;
        currentEntity = undefined;
        currentKind = undefined;
        continue;
      }
      if (!currentModuleName) continue;

      // Bind the module to its Phoenix role via `use` calls.
      if (!currentEntity) {
        const useMatch = /^use\s+([A-Z][\w.]*)(?:,\s*(:?\w+))?/.exec(trimmed);
        if (useMatch) {
          const mod = useMatch[1]!;
          const arg = useMatch[2] ?? '';
          if (mod === 'Phoenix.Controller' || arg === ':controller') currentKind = 'controller';
          else if (mod === 'Phoenix.Router' || arg === ':router') currentKind = 'router';
          else if (mod === 'Phoenix.LiveView') currentKind = 'live-view';
          else if (mod === 'Phoenix.LiveComponent') currentKind = 'live-component';
          else if (mod === 'Ecto.Schema') currentKind = 'schema';
          if (currentKind) {
            const e = makeEntity(input, currentKind, currentModuleName, { moduleName: currentModuleName });
            nodes.push(e);
            edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: currentKind, line: i + 1 }));
            currentEntity = e;
          }
          continue;
        }
      }

      // Controller actions: `def action(conn, params)`.
      if (currentKind === 'controller' && currentEntity) {
        const actionMatch = /^def\s+([a-z_][\w?!]*)\s*\(\s*conn\b/.exec(trimmed);
        if (actionMatch) {
          const action = actionMatch[1]!;
          const e = makeEntity(input, 'action', action, {
            controller: currentEntity.label,
            action,
          });
          nodes.push(e);
          edges.push(edge(currentEntity.id, e.id, EdgeKind.HandlesRoute, {
            controller: currentEntity.label,
            action,
          }));
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'action', line: i + 1 }));
        }
      }

      // Router routes: `get "/path", Controller, :action`.
      if (currentKind === 'router' && currentEntity) {
        // `scope "/prefix", AppWeb do` — push prefix + module arg;
        // matching `end` pops. We track scope opens/closes via the
        // trailing `do` and the line-level `end`.
        const scopeMatch = /^scope\s+"([^"]*)"(?:\s*,\s*([A-Z][\w.]*))?\s*do\b/.exec(trimmed);
        if (scopeMatch) {
          scopeStack.push(scopeMatch[1]!);
          scopeModuleStack.push(scopeMatch[2] ?? '');
          continue;
        }
        if (/^end\b/.test(trimmed) && scopeStack.length > 0) {
          scopeStack.pop();
          scopeModuleStack.pop();
          continue;
        }
        const routeMatch = /^(get|post|put|patch|delete|options|head)\s+"([^"]+)"\s*,\s*([A-Z][\w.]*)\s*,\s*:(\w+)/.exec(trimmed);
        if (routeMatch) {
          const verb = routeMatch[1]!.toUpperCase();
          const localPath = routeMatch[2]!;
          const rawCtrl = routeMatch[3]!;
          const action = routeMatch[4]!;
          if (HTTP_VERBS.has(routeMatch[1]!)) {
            const path = combineScopes(scopeStack, localPath);
            // Qualify the controller with the innermost scope's module
            // argument if it was set and the captured name isn't
            // already a fully-qualified `Mod.Sub.Controller`.
            const innerModule = scopeModuleStack.length > 0 ? scopeModuleStack[scopeModuleStack.length - 1]! : '';
            const ctrl = innerModule && !rawCtrl.includes('.') ? `${innerModule}.${rawCtrl}` : rawCtrl;
            const r = makeRouteEntity(input, currentEntity.label, verb, path, ctrl, action);
            nodes.push(r);
            edges.push(edge(currentEntity.id, r.id, EdgeKind.HandlesRoute, {
              method: verb,
              path,
              controller: ctrl,
              action,
            }));
            edges.push(edge(input.fileNodeId, r.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
          }
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
    id: `framework:phoenix:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['phoenix', subtype],
    data: { framework: 'phoenix', subtype, ...extra },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  routerModule: string,
  method: string,
  path: string,
  controller: string,
  action: string,
): INode {
  return {
    id: `framework:phoenix:route:${input.filePath}#${routerModule}#${method}:${path}#${controller}.${action}`,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path} → ${controller}.${action}`,
    path: input.filePath,
    tags: ['phoenix', 'route'],
    data: { framework: 'phoenix', subtype: 'route', method, path, controller, action, router: routerModule },
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
    source: PHOENIX_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}

/**
 * Combine an outer scope prefix stack with a leaf path. Treats
 * `/` as the no-op prefix. Returns `/` when both prefix and leaf are
 * empty.
 */
function combineScopes(stack: readonly string[], leaf: string): string {
  const prefix = stack
    .map((s) => s.replace(/^\//, '').replace(/\/$/, ''))
    .filter((s) => s.length > 0)
    .join('/');
  const cleanLeaf = leaf.replace(/^\//, '');
  if (!prefix) return cleanLeaf ? '/' + cleanLeaf : '/';
  if (!cleanLeaf) return '/' + prefix;
  return '/' + prefix + '/' + cleanLeaf;
}
