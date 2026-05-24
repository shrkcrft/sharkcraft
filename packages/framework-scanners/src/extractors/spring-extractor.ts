import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const SPRING_EXTRACTOR_SOURCE = 'spring-extractor@v1';

const STEREOTYPES = new Set([
  'Controller',
  'RestController',
  'Service',
  'Repository',
  'Component',
  'Configuration',
]);

const ROUTE_ANNOTATIONS = new Map<string, string | undefined>([
  ['RequestMapping', undefined],
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
]);

const FAST_FILTER_NEEDLES = [
  'org.springframework',
  '@Controller',
  '@RestController',
  '@Service',
  '@Repository',
  '@Component',
  '@RequestMapping',
  '@GetMapping',
  '@PostMapping',
  '@PutMapping',
  '@DeleteMapping',
  '@PatchMapping',
];

/**
 * Spring extractor.
 *
 * Regex-based — Java/Kotlin sources are not AST-parsed. Detection:
 *
 *   - **Bean / stereotype classes**: `@Controller`, `@RestController`,
 *     `@Service`, `@Repository`, `@Component`, `@Configuration`
 *     immediately preceding a `class`/`interface`/`record` declaration
 *     → one entity per matched class with subtype = the annotation name
 *     lower-cased.
 *
 *   - **Routes**: `@RequestMapping`, `@GetMapping`/`@PostMapping`/etc.
 *     on a method (or class). Method-level mappings combine with their
 *     enclosing class's `@RequestMapping` base path. Method derived
 *     from the annotation type (`@GetMapping` → GET); for
 *     `@RequestMapping` the optional `method = RequestMethod.GET`
 *     argument is captured, otherwise the route is tagged `ANY`.
 *
 * Out of scope:
 *   - `@PathVariable`, `@RequestBody`, `@RequestParam` parameter binding.
 *   - WebFlux's `RouterFunction` programmatic routes.
 *   - Spring Security `SecurityFilterChain` configuration.
 */
export const springExtractor: IFrameworkExtractor = {
  framework: 'spring',
  label: 'Spring',
  fileMatches({ path, content }) {
    if (!path.endsWith('.java') && !path.endsWith('.kt')) return false;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];

    const lines = input.content.split('\n');
    // First pass: locate class/interface/record declarations and the
    // annotations immediately preceding them. We track the most recent
    // class's `@RequestMapping` base path so method-level mappings can
    // combine with it.
    let currentClassEntity: INode | undefined;
    let currentClassBasePath = '';

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      const trimmed = raw.trimStart();
      if (trimmed.length === 0) continue;

      // Class declaration (column-0, optionally indented inside files
      // — we accept both for Kotlin's `class` at any indent).
      const classMatch = /^(?:public\s+|private\s+|internal\s+|protected\s+|abstract\s+|final\s+|sealed\s+|open\s+|data\s+)*\s*(class|interface|record)\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (classMatch) {
        const className = classMatch[2]!;
        // Look backwards for annotations on this class.
        const { stereotype, basePath } = scanClassAnnotations(lines, i);
        currentClassBasePath = basePath;
        if (stereotype) {
          const e = makeEntity(input, stereotype.toLowerCase(), className, {
            className,
            stereotype,
            ...(basePath ? { basePath } : {}),
          });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, {
            subtype: stereotype.toLowerCase(),
            line: i + 1,
          }));
          currentClassEntity = e;
        } else if (basePath) {
          // Class without a stereotype but with `@RequestMapping` —
          // still emit a bean entity tagged `mapping` so routes can
          // attach to something.
          const e = makeEntity(input, 'mapping', className, {
            className,
            ...(basePath ? { basePath } : {}),
          });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, {
            subtype: 'mapping',
            line: i + 1,
          }));
          currentClassEntity = e;
        } else {
          currentClassEntity = undefined;
        }
        continue;
      }

      // Method-level route annotation followed by a method declaration.
      const ann = /^@(\w+)(?:\(([^)]*)\))?/.exec(trimmed);
      if (!ann) continue;
      const annName = ann[1]!;
      if (!ROUTE_ANNOTATIONS.has(annName)) continue;
      const annArgs = ann[2] ?? '';

      // Scan forward through additional annotations to the method/fn
      // declaration line. Skip emitting a route if the annotation is
      // actually class-level (e.g. `@RequestMapping("/users")` above a
      // `class UserController`) — that base path is already captured
      // via `scanClassAnnotations`.
      let handlerName: string | undefined;
      let nextIsClass = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const t = lines[j]!.trimStart();
        if (!t) continue;
        if (t.startsWith('@')) continue;
        if (t.startsWith('//') || t.startsWith('/*')) continue;
        if (/^(?:public\s+|private\s+|internal\s+|protected\s+|abstract\s+|final\s+|sealed\s+|open\s+|data\s+)*\s*(class|interface|record)\s+/.test(t)) {
          nextIsClass = true;
          break;
        }
        handlerName = extractMethodName(t);
        break;
      }
      if (nextIsClass) continue;
      const finalHandler = handlerName ?? 'handler';

      const methodPath = parseRoutePath(annArgs);
      const methodMethod = ROUTE_ANNOTATIONS.get(annName)
        ?? parseRequestMethod(annArgs)
        ?? 'ANY';
      const finalPath = combinePaths(currentClassBasePath, methodPath);
      const route = makeRouteEntity(input, currentClassEntity?.label ?? '?', finalHandler, methodMethod, finalPath);
      nodes.push(route);
      if (currentClassEntity) {
        edges.push(edge(currentClassEntity.id, route.id, EdgeKind.HandlesRoute, {
          method: methodMethod,
          path: finalPath,
          handler: finalHandler,
        }));
      }
      edges.push(edge(input.fileNodeId, route.id, EdgeKind.FrameworkDeclares, { subtype: 'route', line: i + 1 }));
    }
    return { nodes, edges };
  },
};

/**
 * Walk backwards from a class-declaration line to collect its
 * stereotype + `@RequestMapping` base path. Stops at the first
 * non-annotation, non-blank line.
 */
function scanClassAnnotations(
  lines: readonly string[],
  classLineIndex: number,
): { stereotype: string | undefined; basePath: string } {
  let stereotype: string | undefined;
  let basePath = '';
  for (let j = classLineIndex - 1; j >= 0; j -= 1) {
    const t = lines[j]!.trimStart();
    if (!t) continue;
    if (!t.startsWith('@')) break;
    const m = /^@(\w+)(?:\(([^)]*)\))?/.exec(t);
    if (!m) continue;
    const name = m[1]!;
    if (STEREOTYPES.has(name)) stereotype = name;
    if (name === 'RequestMapping' || ROUTE_ANNOTATIONS.has(name)) {
      const p = parseRoutePath(m[2] ?? '');
      if (p) basePath = p;
    }
  }
  return { stereotype, basePath };
}

/**
 * Extract the route path from an annotation argument list. Handles
 * `("/path")`, `(value = "/path")`, `(path = "/path")`.
 */
function parseRoutePath(args: string): string {
  const m1 = /^\s*"([^"]*)"/.exec(args);
  if (m1) return m1[1]!;
  const m2 = /(?:value|path)\s*=\s*"([^"]*)"/.exec(args);
  if (m2) return m2[1]!;
  return '';
}

function parseRequestMethod(args: string): string | undefined {
  const m = /method\s*=\s*RequestMethod\.([A-Z]+)/.exec(args);
  if (m) return m[1]!;
  return undefined;
}

function extractMethodName(line: string): string | undefined {
  // Java: `public ReturnType name(...)` or `ReturnType name(...)`. Kotlin: `fun name(...)`.
  let m = /^(?:public\s+|protected\s+|private\s+|static\s+|final\s+|synchronized\s+)*\s*[\w<>\[\],\s]+?\s+([A-Za-z_]\w*)\s*\(/.exec(line);
  if (m) return m[1];
  m = /^(?:public\s+|private\s+|internal\s+|protected\s+|override\s+|suspend\s+|inline\s+)*\s*fun\s+([A-Za-z_]\w*)\s*\(/.exec(line);
  if (m) return m[1];
  return undefined;
}

function combinePaths(base: string, leaf: string): string {
  const b = base.replace(/\/$/, '');
  const l = leaf.startsWith('/') ? leaf : '/' + leaf;
  if (!b) return l || '/';
  if (!leaf) return b || '/';
  return b + l;
}

function makeEntity(
  input: IExtractInput,
  subtype: string,
  label: string,
  extra: Readonly<Record<string, unknown>>,
): INode {
  return {
    id: `framework:spring:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['spring', subtype],
    data: { framework: 'spring', subtype, ...extra },
  };
}

function makeRouteEntity(
  input: IExtractInput,
  className: string,
  handler: string,
  method: string,
  path: string,
): INode {
  return {
    id: `framework:spring:route:${input.filePath}#${className}.${handler}#${method}:${path}`,
    kind: NodeKind.FrameworkEntity,
    label: `${method} ${path}`,
    path: input.filePath,
    tags: ['spring', 'route'],
    data: {
      framework: 'spring',
      subtype: 'route',
      controller: className,
      handler,
      method,
      path,
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
    source: SPRING_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
