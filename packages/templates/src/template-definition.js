export function defineTemplate(input) {
    if (!input.id)
        throw new Error("defineTemplate: 'id' is required");
    if (!input.name)
        throw new Error(`defineTemplate: 'name' is required for ${input.id}`);
    if (!input.files && !(input.targetPath && input.content)) {
        throw new Error(`defineTemplate: ${input.id} must provide either 'files' or both 'targetPath' and 'content'`);
    }
    return {
        ...input,
        tags: Object.freeze([...input.tags]),
        scope: Object.freeze([...input.scope]),
        appliesWhen: Object.freeze([...input.appliesWhen]),
        variables: Object.freeze([...input.variables]),
        postGenerationNotes: input.postGenerationNotes
            ? Object.freeze([...input.postGenerationNotes])
            : undefined,
        related: input.related ? Object.freeze([...input.related]) : undefined,
    };
}
