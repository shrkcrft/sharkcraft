import { createHash } from 'node:crypto';
import { EdgeKind, NodeKind, type IEdge, type INode } from '@shrkcrft/graph';
import type {
  IExtractInput,
  IExtractOutput,
  IFrameworkExtractor,
} from '../extractor-api/framework-extractor.ts';

export const DJANGO_EXTRACTOR_SOURCE = 'django-extractor@v1';

const FAST_FILTER_NEEDLES = [
  'from django',
  'django.db',
  'django.urls',
  'django.views',
  'django.http',
  'models.Model',
  'TemplateView',
  'path(',
  're_path(',
];

/**
 * Django extractor.
 *
 * Regex-only (Python is not parsed via the TS AST). Detection:
 *   - Class inheriting from `models.Model`, `models.AbstractUser`, or
 *     another known Django base → **model** entity.
 *   - Class inheriting from `View`, `TemplateView`, `ListView`, etc. →
 *     **view** entity.
 *   - Function with a leading parameter named `request` (heuristic for
 *     function-based views) → **view** entity.
 *   - `path('<route>', view, name='...')` / `re_path(...)` inside a
 *     `urls.py`-like file → **url-pattern** entity. Detection is loose;
 *     captures the route string + view name when expressible.
 *
 * Out of scope:
 *   - Admin registrations.
 *   - Middleware classes.
 *   - Migration files (Django generates these; treating them as code
 *     would be noisy).
 */
export const djangoExtractor: IFrameworkExtractor = {
  framework: 'django',
  label: 'Django',
  fileMatches({ path, content }) {
    if (!path.endsWith('.py')) return false;
    for (const needle of FAST_FILTER_NEEDLES) {
      if (content.includes(needle)) return true;
    }
    return false;
  },
  extract(input): IExtractOutput {
    const nodes: INode[] = [];
    const edges: IEdge[] = [];

    const isUrlsFile = /(?:^|\/)urls\.py$/.test(input.filePath);
    const lines = input.content.split('\n');

    // Models: `class Foo(models.Model):` or `class Foo(AbstractBaseUser):`.
    const modelRe = /^class\s+([A-Za-z_]\w*)\s*\((?:[\w.]*\.)?(?:Model|AbstractUser|AbstractBaseUser|AbstractModel|TimeStampedModel)\b/;
    // CBVs: a class whose first base name ends in `View`.
    const viewRe = /^class\s+([A-Za-z_]\w*)\s*\(([^)]+)\)/;
    // FBVs: function whose first parameter is `request`.
    const fbvRe = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(\s*request\b/;
    // URL pattern: `path('<route>', view, ...)` or `re_path(...)`.
    const urlRe = /(?:^|\s)(?:path|re_path|url)\s*\(\s*['"]([^'"]*)['"]\s*,\s*([A-Za-z_][\w.]*)(?:\.as_view\(\))?/;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const line = i + 1;
      let m: RegExpExecArray | null;
      if ((m = modelRe.exec(raw))) {
        const e = makeEntity(input, 'model', m[1]!, { className: m[1]! });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'model', line }));
        continue;
      }
      if ((m = viewRe.exec(raw))) {
        const className = m[1]!;
        const bases = m[2]!.split(',').map((s) => s.trim());
        // Pick first base that looks like a view (ends in 'View') and isn't a model base.
        if (bases.some((b) => /View$/.test(b)) && !bases.some((b) => /Model$|AbstractUser|AbstractBaseUser/.test(b))) {
          const e = makeEntity(input, 'view', className, { className, kind: 'cbv', bases });
          nodes.push(e);
          edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'view', line }));
        }
        continue;
      }
      if ((m = fbvRe.exec(raw))) {
        const name = m[1]!;
        const e = makeEntity(input, 'view', name, { kind: 'fbv' });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'view', line }));
        continue;
      }
      if (isUrlsFile && (m = urlRe.exec(raw))) {
        const route = m[1]!;
        const target = m[2]!;
        const e = makeEntity(input, 'url-pattern', `${route} → ${target}`, {
          route,
          target,
        });
        nodes.push(e);
        edges.push(edge(input.fileNodeId, e.id, EdgeKind.FrameworkDeclares, { subtype: 'url-pattern', line }));
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
    id: `framework:django:${subtype}:${input.filePath}#${label}`,
    kind: NodeKind.FrameworkEntity,
    label,
    path: input.filePath,
    tags: ['django', subtype],
    data: { framework: 'django', subtype, ...extra },
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
    source: DJANGO_EXTRACTOR_SOURCE,
    ...(data ? { data } : {}),
  };
}
