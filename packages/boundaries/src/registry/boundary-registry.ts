import type { IBoundaryRule } from '../model/boundary-rule.ts';

export class BoundaryRegistry {
  private readonly byId = new Map<string, IBoundaryRule>();

  constructor(rules: readonly IBoundaryRule[] = []) {
    for (const r of rules) this.add(r);
  }
  add(rule: IBoundaryRule): void {
    this.byId.set(rule.id, rule);
  }
  has(id: string): boolean {
    return this.byId.has(id);
  }
  get(id: string): IBoundaryRule | undefined {
    return this.byId.get(id);
  }
  list(): readonly IBoundaryRule[] {
    return [...this.byId.values()];
  }
  size(): number {
    return this.byId.size;
  }
}
