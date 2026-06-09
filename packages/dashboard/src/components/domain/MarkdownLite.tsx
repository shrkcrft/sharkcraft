import { Fragment, type ReactNode } from 'react';

/**
 * Tiny, dependency-free, XSS-safe Markdown renderer for knowledge content.
 * Renders React elements only (never dangerouslySetInnerHTML). Supports the
 * subset that shows up in knowledge entries: fenced code blocks, headings,
 * unordered/ordered lists, blockquotes, paragraphs, and inline `code`,
 * **bold**, and `[text](url)` links. Anything it doesn't recognize falls back
 * to plain text.
 */
export interface IMarkdownLiteProps {
  text: string;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

/**
 * Return a safe href for an inline link, or null to render it as plain text.
 * Only http(s), mailto, in-page anchors, and relative paths are allowed —
 * `javascript:`/`data:` and other active schemes are rejected so the renderer
 * can never become an injection vector.
 */
function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  if (u.startsWith('/') || u.startsWith('#') || u.startsWith('./') || u.startsWith('../')) return u;
  return null;
}

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(INLINE);
  parts.forEach((part, i) => {
    if (!part) return;
    const link = LINK.exec(part);
    if (part.startsWith('`') && part.endsWith('`')) {
      out.push(<code key={`${keyBase}-c${i}`} className="kb-md__icode">{part.slice(1, -1)}</code>);
    } else if (part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={`${keyBase}-b${i}`}>{part.slice(2, -2)}</strong>);
    } else if (link) {
      const href = safeHref(link[2]!);
      out.push(
        href ? (
          <a
            key={`${keyBase}-l${i}`}
            className="kb-md__link"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {link[1]}
          </a>
        ) : (
          <Fragment key={`${keyBase}-l${i}`}>{link[1]}</Fragment>
        ),
      );
    } else {
      out.push(<Fragment key={`${keyBase}-t${i}`}>{part}</Fragment>);
    }
  });
  return out;
}

interface IBlock {
  kind: 'code' | 'ul' | 'ol' | 'h' | 'quote' | 'p';
  lines: string[];
  level?: number;
}

function toBlocks(text: string): IBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: IBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code.
    if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push({ kind: 'code', lines: body });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', lines: [heading[2]!], level: heading[1]!.length });
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ul', lines: body });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ol', lines: body });
      continue;
    }
    // Paragraph: gather until blank or a block starter.
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.trimStart().startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!)
    ) {
      body.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: 'p', lines: body });
  }
  return blocks;
}

export function MarkdownLite({ text }: IMarkdownLiteProps): JSX.Element {
  const blocks = toBlocks(text);
  return (
    <div className="kb-md">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        if (b.kind === 'code') {
          return <pre key={key} className="kb-md__code">{b.lines.join('\n')}</pre>;
        }
        if (b.kind === 'h') {
          return <div key={key} className={`kb-md__h kb-md__h--${b.level ?? 3}`}>{renderInline(b.lines[0] ?? '', key)}</div>;
        }
        if (b.kind === 'quote') {
          return <blockquote key={key} className="kb-md__quote">{renderInline(b.lines.join(' '), key)}</blockquote>;
        }
        if (b.kind === 'ul') {
          return (
            <ul key={key} className="kb-md__list">
              {b.lines.map((l, j) => <li key={`${key}-${j}`}>{renderInline(l, `${key}-${j}`)}</li>)}
            </ul>
          );
        }
        if (b.kind === 'ol') {
          return (
            <ol key={key} className="kb-md__list">
              {b.lines.map((l, j) => <li key={`${key}-${j}`}>{renderInline(l, `${key}-${j}`)}</li>)}
            </ol>
          );
        }
        return <p key={key} className="kb-md__p">{renderInline(b.lines.join(' '), key)}</p>;
      })}
    </div>
  );
}
