var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
function isLikelyEntry(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.id === 'string' && typeof v.title === 'string' && typeof v.content === 'string';
}
function collectEntriesFromModule(mod, entries) {
    const seen = new Set();
    const tryPush = (value) => {
        if (!isLikelyEntry(value))
            return;
        if (seen.has(value.id))
            return;
        seen.add(value.id);
        entries.push(value);
    };
    for (const key of Object.keys(mod)) {
        const value = mod[key];
        if (isLikelyEntry(value)) {
            tryPush(value);
        }
        else if (Array.isArray(value)) {
            for (const item of value)
                tryPush(item);
        }
        else if (value && typeof value === 'object' && 'entries' in value) {
            const inner = value.entries;
            if (Array.isArray(inner)) {
                for (const item of inner)
                    tryPush(item);
            }
        }
    }
}
export class TypeScriptKnowledgeLoader {
    canLoad(filePath) {
        return TS_EXTENSIONS.has(extname(filePath));
    }
    async load(filePath) {
        const warnings = [];
        const entries = [];
        const sourceFiles = [];
        if (!existsSync(filePath)) {
            warnings.push(`Knowledge file not found: ${filePath}`);
            return { entries, warnings, sourceFiles };
        }
        sourceFiles.push(filePath);
        try {
            const mod = (await import(__rewriteRelativeImportExtension(pathToFileURL(filePath).href)));
            collectEntriesFromModule(mod, entries);
            // Annotate source
            for (const entry of entries) {
                if (!entry.source?.origin) {
                    entry.source = {
                        origin: filePath,
                        loader: 'typescript',
                    };
                }
            }
            if (entries.length === 0) {
                warnings.push(`No knowledge entries detected in ${filePath}`);
            }
        }
        catch (e) {
            warnings.push(`Failed to import ${filePath}: ${e.message}`);
        }
        return { entries, warnings, sourceFiles };
    }
}
