export function renderTemplate(template, values) {
    const files = [];
    if (template.files) {
        for (const f of template.files(values)) {
            files.push({
                targetPath: f.targetPath,
                content: f.content,
                language: f.language,
                overwrite: f.overwrite ?? false,
            });
        }
    }
    else if (template.targetPath && template.content) {
        const target = typeof template.targetPath === 'function' ? template.targetPath(values) : template.targetPath;
        const content = typeof template.content === 'function' ? template.content(values) : template.content;
        files.push({ targetPath: target, content, overwrite: false });
    }
    return {
        templateId: template.id,
        files,
        postGenerationNotes: template.postGenerationNotes ?? [],
    };
}
