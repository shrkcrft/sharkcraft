export class TemplateRegistry {
    byId = new Map();
    constructor(templates = []) {
        for (const t of templates)
            this.register(t);
    }
    register(template) {
        this.byId.set(template.id, template);
    }
    get(id) {
        return this.byId.get(id) ?? null;
    }
    has(id) {
        return this.byId.has(id);
    }
    list() {
        return [...this.byId.values()];
    }
    search(query) {
        const q = query.trim().toLowerCase();
        if (!q)
            return this.list();
        return this.list().filter((t) => {
            return (t.id.toLowerCase().includes(q) ||
                t.name.toLowerCase().includes(q) ||
                t.description.toLowerCase().includes(q) ||
                t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
                t.scope.some((s) => s.toLowerCase().includes(q)) ||
                t.appliesWhen.some((a) => a.toLowerCase().includes(q)));
        });
    }
}
