import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const LARAVEL_EXTRACTOR_SOURCE = 'laravel-extractor@v1';

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match']);

const FAST_FILTER_NEEDLES = [
  'Illuminate\\',
  'extends Controller',
  'extends Model',
  'extends Authenticatable',
  'extends JsonResource',
  'Route::',
];

/**
 * Laravel framework extractor.
 *
 * Regex-only. Detection:
 *   - Class extending `Controller` / `BaseController` / `RestController` → controller.
 *   - Class extending `Model` / `Authenticatable` / `Pivot` → model.
 *   - Class extending `JsonResource` / `ResourceCollection` → resource.
 *   - `Route::get('/path', [Controller::class, 'action'])` (and other verbs) → route.
 *   - `Route::resource('users', UserController::class)` → route (RESOURCE).
 *
 * Inside controllers, every `public function name(...)` becomes an
 * action entity wired back to the controller via `HandlesRoute`.
 *
 * Out of scope:
 *   - Route groups (`Route::middleware(...)->group(function () { … })`)
 *   - Model relations (hasMany, belongsTo, …).
 *   - Blade templates.
 */
export const laravelExtractor: IFrameworkExtractor = {
  framework: 'laravel',
  label: 'Laravel',
  fileMatches({ path, content }) {
    if (!path.endsWith('.php')) return false;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const lines = input.content.split('\n');

    let currentControllerEntity: INode | undefined;

    // Stack of route-group prefixes from chained Route::prefix(...)->group
    // and Route::middleware(...)->group(...) calls. A `->group(function`
    // line pushes a captured prefix (empty when only middleware is
    // applied), and the closing `});` pops.
    const groupPrefixStack: string[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      const trimmed = raw.trimStart();

      // Detect group opens: e.g. `Route::prefix('/api')->group(function () {`
      // or `Route::middleware(['auth'])->prefix('/v1')->group(function () {`.
      // We pull the first `prefix('/x')` we see on the line if any; absent
      // prefix → empty string.
      const groupOpen = /->group\s*\(\s*function/.test(trimmed) && /Route::/.test(trimmed);
      if (groupOpen) {
        // `Route::prefix('/api')` (initial call) and chained
        // `->prefix('/v1')` both need to be captured. We pick the
        // first prefix on the line (outermost wins for nested
        // chains).
        const prefMatch = /(?:Route::|->)\s*prefix\s*\(\s*['"]([^'"]+)['"]/.exec(trimmed);
        const prefix = prefMatch ? prefMatch[1]! : '';
        groupPrefixStack.push(prefix);
        continue;
      }
      // Closing `});` (typical for the group callback). Pop the
      // innermost prefix.
      if (groupPrefixStack.length > 0 && /^\}\s*\)\s*;?\s*$/.test(trimmed)) {
        groupPrefixStack.pop();
        continue;
      }

      // class FooController extends Controller
      let m = /^(?:abstract\s+|final\s+)*class\s+([A-Z]\w*)\s+extends\s+(\w+)/.exec(trimmed);
      if (m) {
        const className = m[1]!;
        const baseClass = m[2]!;
        if (/(?:^|[A-Za-z])Controller$/.test(baseClass) || /BaseController$/.test(baseClass)) {
          const e = makeEntity(input, 'controller', className, { className, baseClass });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'controller', line: i + 1 }));
          currentControllerEntity = e;
          continue;
        }
        if (baseClass === 'Model' || baseClass === 'Authenticatable' || baseClass === 'Pivot') {
          const e = makeEntity(input, 'model', className, { className, baseClass });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'model', line: i + 1 }));
          continue;
        }
        if (baseClass === 'JsonResource' || baseClass === 'ResourceCollection') {
          const e = makeEntity(input, 'resource', className, { className, baseClass });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'resource', line: i + 1 }));
          continue;
        }
        // Unrelated class — stop the controller-action capture.
        currentControllerEntity = undefined;
        continue;
      }

      // Closing `}` at column 0 ends the class body.
      if (raw === '}' || raw.trimEnd() === '}') {
        currentControllerEntity = undefined;
      }

      // Public action methods inside a controller body.
      if (currentControllerEntity) {
        m = /^\s+public\s+function\s+([a-zA-Z_]\w*)\s*\(/.exec(raw);
        if (m && !m[1]!.startsWith('__')) {
          const action = m[1]!;
          const e = makeEntity(input, 'action', action, {
            controller: currentControllerEntity.label,
            action,
          });
          nodes.push(e);
          edges.push(edge(currentControllerEntity.id, e.id, EdgeKind.HandlesRoute, {
            controller: currentControllerEntity.label,
            action,
          }));
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'action', line: i + 1 }));
        }
      }

      // Route registrations: Route::get('/path', [Ctrl::class, 'action'])
      // or Route::get('/path', 'Ctrl@action') or Route::resource('x', Ctrl::class)
      const verbMatch =
        /Route::(\w+)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*(?:\[([^\]]+)\]|['"]([^'"]+)['"]|([A-Z]\w*)::class))?/.exec(trimmed);
      if (verbMatch) {
        const verb = verbMatch[1]!;
        const localPath = verbMatch[2]!;
        const groupPrefix = combinePrefixes(groupPrefixStack);
        if (verb === 'resource' || verb === 'apiResource') {
          // Three possible target shapes: array, string, or bare `Foo::class`.
          const target = verbMatch[5] ?? verbMatch[4] ?? verbMatch[3] ?? '';
          const r = makeRouteEntity(input, verb.toUpperCase(), `${groupPrefix}/${localPath}`, target);
          nodes.push(r);
          edges.push(edge(input.fileNodeId, r.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
          continue;
        }
        if (!ROUTE_VERBS.has(verb)) continue;
        const verbUpper = verb.toUpperCase();
        let target = verbMatch[4] ?? '';
        if (verbMatch[3]) {
          // Array form `[Ctrl::class, 'method']`.
          const inside = verbMatch[3];
          const ctrlM = /([A-Z]\w*)::class\s*,\s*['"]([^'"]+)['"]/.exec(inside);
          if (ctrlM) target = `${ctrlM[1]!}@${ctrlM[2]!}`;
        }
        const path = combinePathWithGroup(groupPrefix, localPath);
        const r = makeRouteEntity(input, verbUpper, path, target);
        nodes.push(r);
        edges.push(edge(input.fileNodeId, r.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
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
    id: `framework:laravel:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['laravel', subtype],
    data: { framework: 'laravel', subtype, ...extra },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  method: string,
  path: string,
  target: string,
): INode {
  return {
    id: `framework:laravel:route:${input.filePath}#${method}:${path}#${target}`,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path}${target ? ` → ${target}` : ''}`,
    path: input.filePath,
    tags: ['laravel', 'route'],
    data: { framework: 'laravel', subtype: 'route', method, path, target },
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
    source: LARAVEL_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}

/**
 * Combine the prefix stack (innermost first → joined left-to-right) into
 * a single leading prefix. Returns '' when no group is active.
 */
function combinePrefixes(stack: readonly string[]): string {
  const parts = stack
    .map((s) => s.replace(/^\//, '').replace(/\/$/, ''))
    .filter((s) => s.length > 0);
  if (parts.length === 0) return '';
  return '/' + parts.join('/');
}

function combinePathWithGroup(prefix: string, leaf: string): string {
  if (!prefix) return leaf;
  const cleanLeaf = leaf.startsWith('/') ? leaf : '/' + leaf;
  return prefix + cleanLeaf;
}
