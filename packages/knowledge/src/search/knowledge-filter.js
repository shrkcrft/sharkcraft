export function filterKnowledge(entries, options) {
    return entries.filter((entry) => {
        if (options.types?.length && !options.types.includes(String(entry.type)))
            return false;
        if (options.scope?.length && !options.scope.some((s) => entry.scope.includes(s)))
            return false;
        if (options.tags?.length && !options.tags.every((t) => entry.tags.includes(t)))
            return false;
        if (options.appliesWhen?.length &&
            !options.appliesWhen.some((a) => entry.appliesWhen.includes(a))) {
            return false;
        }
        return true;
    });
}
