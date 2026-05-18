import type { ITemplateDefinition } from './template-definition.ts';

export class TemplateRegistry {
  private readonly byId = new Map<string, ITemplateDefinition>();

  constructor(templates: readonly ITemplateDefinition[] = []) {
    for (const t of templates) this.register(t);
  }

  register(template: ITemplateDefinition): void {
    this.byId.set(template.id, template);
  }

  get(id: string): ITemplateDefinition | null {
    return this.byId.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): ITemplateDefinition[] {
    return [...this.byId.values()];
  }

  search(query: string): ITemplateDefinition[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter((t) => {
      return (
        t.id.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        t.scope.some((s) => s.toLowerCase().includes(q)) ||
        t.appliesWhen.some((a) => a.toLowerCase().includes(q))
      );
    });
  }
}
