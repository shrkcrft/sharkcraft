import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const FLUTTER_EXTRACTOR_SOURCE = 'flutter-extractor@v1';

const WIDGET_BASES = new Set([
  'StatelessWidget',
  'StatefulWidget',
  'ConsumerWidget',
  'HookWidget',
  'HookConsumerWidget',
]);

const FAST_FILTER_NEEDLES = [
  "package:flutter/",
  'extends StatelessWidget',
  'extends StatefulWidget',
  'extends State<',
  'ChangeNotifier',
  'ConsumerWidget',
];

/**
 * Flutter framework extractor.
 *
 * Regex-only — Dart source isn't AST-parsed. Detection:
 *
 *   - **Widget**: `class X extends StatelessWidget` / `StatefulWidget` /
 *     `ConsumerWidget` / `HookWidget` / `HookConsumerWidget`. Emits
 *     one entity per matched class.
 *
 *   - **State**: `class _XState extends State<X>` →
 *     state entity, linked to its parent widget via `UsesHook` edges
 *     (re-using the edge kind for "this state belongs to that widget").
 *
 *   - **Notifier**: `class X extends ChangeNotifier` /
 *     `class X with ChangeNotifier` → notifier entity. Common for
 *     Provider / Riverpod-style state.
 *
 * Out of scope:
 *   - Widget tree inspection (the `build()` body).
 *   - InheritedWidget chains.
 *   - Riverpod provider declarations.
 */
export const flutterExtractor: IFrameworkExtractor = {
  framework: 'flutter',
  label: 'Flutter',
  fileMatches({ path, content }) {
    if (!path.endsWith('.dart')) return false;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];
    const lines = input.content.split('\n');

    // Track widget classes so a follow-up `_XState extends State<X>`
    // can link back via the X parameter.
    const widgetEntities = new Map<string, INode>();

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      if (raw.startsWith(' ') || raw.startsWith('\t')) continue;
      const trimmed = raw.trimStart();

      // Widget classes.
      let m = /^class\s+([A-Za-z_]\w*)\s+extends\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (m) {
        const className = m[1]!;
        const baseClass = m[2]!;
        if (WIDGET_BASES.has(baseClass)) {
          const e = makeEntity(input, 'widget', className, {
            className,
            baseClass,
            stateful: baseClass === 'StatefulWidget',
          });
          widgetEntities.set(className, e);
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'widget', line: i + 1 }));
          continue;
        }
        if (baseClass === 'ChangeNotifier') {
          const e = makeEntity(input, 'notifier', className, { className, baseClass });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'notifier', line: i + 1 }));
          continue;
        }
      }

      // State<Widget> classes.
      m = /^class\s+([A-Za-z_]\w*)\s+extends\s+State\s*<\s*([A-Za-z_]\w*)\s*>/.exec(trimmed);
      if (m) {
        const stateName = m[1]!;
        const widgetName = m[2]!;
        const e = makeEntity(input, 'state', stateName, {
          stateName,
          widget: widgetName,
        });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'state', line: i + 1 }));
        // Wire state → widget if we've seen the widget already.
        const widget = widgetEntities.get(widgetName);
        if (widget) {
          edges.push(edge(widget.id, e.id, EdgeKind.UsesHook, { kind: 'state', widget: widgetName }));
        }
        continue;
      }

      // Mixin form: `class X extends Y with ChangeNotifier`
      m = /^class\s+([A-Za-z_]\w*)\s+(?:extends\s+[A-Za-z_]\w*\s+)?with\s+([^{]+)/.exec(trimmed);
      if (m && m[2]!.split(',').map((s) => s.trim()).includes('ChangeNotifier')) {
        const className = m[1]!;
        const e = makeEntity(input, 'notifier', className, { className, baseClass: 'with ChangeNotifier' });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'notifier', line: i + 1 }));
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
    id: `framework:flutter:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['flutter', subtype],
    data: { framework: 'flutter', subtype, ...extra },
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
    source: FLUTTER_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
