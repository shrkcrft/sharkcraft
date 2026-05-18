export function defineKnowledgeBase(input) {
    return { name: input.name, entries: Object.freeze([...input.entries]) };
}
