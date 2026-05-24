import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const VUE_EXTRACTOR_SOURCE = 'vue-extractor@v1';

const SCRIPT_OPEN_RE = /<script\b[^>]*>/i;
const SCRIPT_CLOSE_RE = /<\/script>/i;
const SETUP_RE = /<script[^>]*\bsetup\b[^>]*>/i;
const DEFINE_COMPONENT_RE = /\b(defineComponent|defineAsyncComponent)\s*\(/;
const COMPOSITION_HOOK_RE = /\b(ref|reactive|computed|watch|onMounted|onUnmounted|onBeforeMount|onUpdated)\s*\(/g;
const NAME_OPTION_RE = /\bname\s*:\s*['"`]([^'"`]+)['"`]/;

/**
 * Vue extractor.
 *
 * Detection sources (in order):
 *   1. `.vue` SFC files — always a component, named after the filename.
 *   2. `.ts` / `.tsx` / `.js` / `.jsx` files containing
 *      `defineComponent(` or `defineAsyncComponent(` — emits a
 *      component entity per call.
 *
 * For SFC files we also detect Composition API hook usages from the
 * `<script>` block via regex (lightweight — no template parsing).
 *
 * Out of scope: template parsing, <style> block detection, scoped slots.
 */
export const vueExtractor: IFrameworkExtractor = {
  framework: 'vue',
  label: 'Vue',
  fileMatches({ path, content }) {
    if (path.endsWith('.vue')) return true;
    if (!/\.(?:t|j)sx?$/.test(path)) return false;
    return DEFINE_COMPONENT_RE.test(content) || content.includes("from 'vue'") || content.includes('from "vue"');
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    if (input.filePath.endsWith('.vue')) {
      extractFromSfc(input, nodes, edges);
    } else {
      extractFromTs(input, nodes, edges);
    }
    return { nodes, edges };
  },
};

function extractFromSfc(input: IExtractInput, nodes: INode[], edges: IEdge[]): void {
  const script = extractScriptBlock(input.content);
  const isSetup = SETUP_RE.test(input.content);
  // Component name from filename (without ext); honor `name:` option if present in script.
  const filename = input.filePath.split('/').pop()!.replace(/\.vue$/, '');
  let name = filename;
  if (!isSetup) {
    const m = script.match(NAME_OPTION_RE);
    if (m) name = m[1]!;
  }
  const entity = makeEntity(input, 'component', name, {
    sfc: true,
    setup: isSetup,
  });
  nodes.push(entity);
  edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: 'component' }));
  // Composition API hook usages.
  const hooks = new Set<string>();
  let m: RegExpExecArray | null;
  COMPOSITION_HOOK_RE.lastIndex = 0;
  while ((m = COMPOSITION_HOOK_RE.exec(script)) !== null) {
    hooks.add(m[1]!);
  }
  for (const hook of hooks) {
    const hookEntity = makeEntity(input, 'hook-usage', hook, { hook });
    nodes.push(hookEntity);
    edges.push(edge(entity.id, hookEntity.id, EdgeKind.UsesHook, { hook }));
    edges.push(edge(input.fileNodeId, hookEntity.id, EdgeKind.FrameworkDeclares, { subtype: 'hook-usage' }));
  }
}

function extractFromTs(input: IExtractInput, nodes: INode[], edges: IEdge[]): void {
  // Walk every `defineComponent(...)` call. We don't need an AST —
  // regex with a captured-string `name:` option is enough for the MVP.
  const re = /\bdefineComponent\s*\(\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(input.content)) !== null) {
    idx += 1;
    const body = m[1] ?? '';
    const nameMatch = body.match(NAME_OPTION_RE);
    const name = nameMatch ? nameMatch[1]! : `Component${idx}`;
    const entity = makeEntity(input, 'component', name, { sfc: false });
    nodes.push(entity);
    edges.push(edge(input.fileNodeId, entity.id, EdgeKind.FrameworkDeclares, { subtype: 'component' }));
  }
}

function extractScriptBlock(content: string): string {
  const open = content.search(SCRIPT_OPEN_RE);
  if (open < 0) return '';
  const after = content.slice(open).indexOf('>');
  if (after < 0) return '';
  const start = open + after + 1;
  const closeIdx = content.slice(start).search(SCRIPT_CLOSE_RE);
  if (closeIdx < 0) return content.slice(start);
  return content.slice(start, start + closeIdx);
}

function makeEntity(
  input: IExtractInput,
  subtype: string,
  name: string,
  extra: Readonly<Record<string, unknown>>,
): INode {
  return {
    id: `framework:vue:${subtype}:${input.filePath}#${name}`,
    kind: NodeKind.FrameworkEntity,
    label: name,
    path: input.filePath,
    tags: ['vue', subtype],
    data: { framework: 'vue', subtype, name, ...extra },
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
    source: VUE_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
