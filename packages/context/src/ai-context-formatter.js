export function formatEntryForContext(entry, options = {}) {
    const lines = [];
    const meta = [
        `id:${entry.id}`,
        `priority:${entry.priority}`,
        entry.scope.length ? `scope:[${entry.scope.join(',')}]` : '',
        entry.tags.length ? `tags:[${entry.tags.join(',')}]` : '',
    ]
        .filter(Boolean)
        .join(' ');
    lines.push(`### ${entry.title} (${meta})`);
    if (entry.summary) {
        lines.push(entry.summary.trim());
    }
    let content = entry.content.trim();
    if (options.maxContentChars && content.length > options.maxContentChars) {
        content = content.slice(0, options.maxContentChars) + '…';
    }
    lines.push(content);
    if (options.includeExamples && entry.examples?.length) {
        lines.push('Examples:');
        for (const ex of entry.examples) {
            if (ex.title)
                lines.push(`- ${ex.title}`);
            if (ex.code) {
                const lang = ex.language ?? '';
                lines.push('```' + lang);
                lines.push(ex.code.trim());
                lines.push('```');
            }
        }
    }
    return lines.join('\n');
}
export function formatSectionBody(entries, options = {}) {
    return entries.map((e) => formatEntryForContext(e, options)).join('\n\n');
}
