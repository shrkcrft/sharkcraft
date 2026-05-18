import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildProjectOverview, renderOverviewText, AGENT_INSTRUCTIONS } from '@shrkcrft/inspector';
import { formatEntryFull } from '@shrkcrft/knowledge';
import { parseResourceUri } from "./resource-uris.js";
export function readResource(inspection, uri) {
    const parsed = parseResourceUri(uri);
    if (parsed.kind === 'overview') {
        const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
        return {
            ok: true,
            contents: [
                {
                    uri,
                    mimeType: 'text/plain',
                    text: renderOverviewText(overview),
                },
            ],
        };
    }
    if (parsed.kind === 'agent-instructions') {
        return {
            ok: true,
            contents: [{ uri, mimeType: 'text/markdown', text: AGENT_INSTRUCTIONS }],
        };
    }
    if (parsed.kind === 'knowledge' && parsed.id) {
        const entry = inspection.index.get(parsed.id);
        if (!entry)
            return { ok: false, error: `No knowledge entry with id "${parsed.id}".` };
        return {
            ok: true,
            contents: [
                {
                    uri,
                    mimeType: 'text/markdown',
                    text: formatEntryFull(entry),
                },
            ],
        };
    }
    if (parsed.kind === 'template' && parsed.id) {
        const template = inspection.templateRegistry.get(parsed.id);
        if (!template)
            return { ok: false, error: `No template with id "${parsed.id}".` };
        const safe = {
            id: template.id,
            name: template.name,
            description: template.description,
            tags: template.tags,
            scope: template.scope,
            appliesWhen: template.appliesWhen,
            variables: template.variables,
            postGenerationNotes: template.postGenerationNotes ?? [],
            related: template.related ?? [],
        };
        return {
            ok: true,
            contents: [
                {
                    uri,
                    mimeType: 'application/json',
                    text: JSON.stringify(safe, null, 2),
                },
            ],
        };
    }
    if (parsed.kind === 'docs' && parsed.path) {
        if (!inspection.sharkcraftDir) {
            return { ok: false, error: 'No sharkcraft/ folder is available.' };
        }
        // Resolve and verify the doc path lives inside sharkcraftDir.
        const candidate = nodePath.resolve(inspection.sharkcraftDir, parsed.path);
        const relative = nodePath.relative(inspection.sharkcraftDir, candidate);
        if (relative === '' || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
            return { ok: false, error: `Doc path escapes sharkcraft/: ${parsed.path}` };
        }
        if (!existsSync(candidate)) {
            return { ok: false, error: `Doc file not found: ${parsed.path}` };
        }
        let text;
        try {
            text = readFileSync(candidate, 'utf8');
        }
        catch (e) {
            return {
                ok: false,
                error: `Failed to read doc ${parsed.path}: ${e.message}`,
            };
        }
        return {
            ok: true,
            contents: [{ uri, mimeType: 'text/markdown', text }],
        };
    }
    return { ok: false, error: `Unsupported resource URI: ${uri}` };
}
