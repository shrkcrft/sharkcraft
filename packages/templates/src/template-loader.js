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
function isTemplate(value) {
    if (!value || typeof value !== 'object')
        return false;
    const v = value;
    return typeof v.id === 'string' && typeof v.name === 'string';
}
export async function loadTemplatesFromFile(filePath) {
    const warnings = [];
    const templates = [];
    const sourceFiles = [];
    if (!existsSync(filePath)) {
        warnings.push(`Template file not found: ${filePath}`);
        return { templates, warnings, sourceFiles };
    }
    sourceFiles.push(filePath);
    try {
        const mod = (await import(__rewriteRelativeImportExtension(pathToFileURL(filePath).href)));
        const seen = new Set();
        const tryPush = (v) => {
            if (!isTemplate(v))
                return;
            if (seen.has(v.id))
                return;
            seen.add(v.id);
            templates.push(v);
        };
        for (const key of Object.keys(mod)) {
            const v = mod[key];
            if (isTemplate(v)) {
                tryPush(v);
            }
            else if (Array.isArray(v)) {
                for (const item of v)
                    tryPush(item);
            }
        }
        if (templates.length === 0)
            warnings.push(`No templates exported by ${filePath}`);
    }
    catch (e) {
        warnings.push(`Failed to import ${filePath}: ${e.message}`);
    }
    return { templates, warnings, sourceFiles };
}
