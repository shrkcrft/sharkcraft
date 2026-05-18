import { extname, basename } from 'node:path';
import type { ISharkcraftInspection } from '@shrkcrft/inspector';
import {
  AGENT_INSTRUCTIONS_URI,
  docUri,
  knowledgeUri,
  OVERVIEW_URI,
  templateUri,
} from './resource-uris.ts';

export interface IResourceListItem {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * Resources advertised by SharkCraft. Read-only by design — there is no
 * resource-write endpoint. AI agents use these to fetch background info
 * without invoking a tool call.
 */
export function buildResourceList(inspection: ISharkcraftInspection): IResourceListItem[] {
  const items: IResourceListItem[] = [];

  items.push({
    uri: OVERVIEW_URI,
    name: 'Project overview',
    description: 'Compact project summary (name, package manager, frameworks, scripts).',
    mimeType: 'text/plain',
  });

  items.push({
    uri: AGENT_INSTRUCTIONS_URI,
    name: 'Agent instructions',
    description: 'How AI agents should use SharkCraft tools and resources.',
    mimeType: 'text/markdown',
  });

  for (const entry of inspection.knowledgeEntries) {
    items.push({
      uri: knowledgeUri(entry.id),
      name: entry.title,
      description: `[${entry.type}, ${entry.priority}] ${entry.summary ?? ''}`.trim(),
      mimeType: 'text/markdown',
    });
  }

  for (const template of inspection.templates) {
    items.push({
      uri: templateUri(template.id),
      name: `Template: ${template.name}`,
      description: template.description,
      mimeType: 'application/json',
    });
  }

  // Markdown source docs — discoverable via inspection.sourceFiles, but we
  // expose only .md files. The `path` field becomes the URI path component.
  for (const sourceFile of inspection.sourceFiles) {
    if (extname(sourceFile).toLowerCase() !== '.md') continue;
    const sharkcraftDir = inspection.sharkcraftDir;
    let relPath = basename(sourceFile);
    if (sharkcraftDir && sourceFile.startsWith(sharkcraftDir + '/')) {
      relPath = sourceFile.slice(sharkcraftDir.length + 1);
    }
    items.push({
      uri: docUri(relPath),
      name: `Doc: ${relPath}`,
      description: `Source markdown file at sharkcraft/${relPath}`,
      mimeType: 'text/markdown',
    });
  }

  return items;
}
