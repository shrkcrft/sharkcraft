import type { IPipelineDefinition } from '../model/pipeline-definition.ts';

export class PipelineRegistry {
  private readonly byId = new Map<string, IPipelineDefinition>();

  constructor(pipelines: readonly IPipelineDefinition[] = []) {
    for (const p of pipelines) this.register(p);
  }

  register(pipeline: IPipelineDefinition): void {
    this.byId.set(pipeline.id, pipeline);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): IPipelineDefinition | null {
    return this.byId.get(id) ?? null;
  }

  list(): IPipelineDefinition[] {
    return [...this.byId.values()];
  }

  search(query: string): IPipelineDefinition[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.list();
    return this.list().filter((p) => {
      return (
        p.id.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
        (p.appliesWhen ?? []).some((a) => a.toLowerCase().includes(q))
      );
    });
  }

  /**
   * Crude relevance: bias by overlap of task words with appliesWhen / tags /
   * title. Returns the top `limit` pipelines (default 5).
   */
  relevantFor(task: string, limit = 5): IPipelineDefinition[] {
    const taskLower = task.toLowerCase();
    const words = taskLower.split(/\W+/).filter((w) => w.length >= 3);
    const scored = this.list().map((p) => {
      let score = 0;
      for (const tag of p.tags ?? []) {
        if (taskLower.includes(tag.toLowerCase())) score += 5;
      }
      for (const a of p.appliesWhen ?? []) {
        if (taskLower.includes(a.toLowerCase())) score += 6;
      }
      if (p.title.toLowerCase().includes(taskLower)) score += 4;
      for (const w of words) {
        if (p.id.toLowerCase().includes(w)) score += 2;
        if (p.description.toLowerCase().includes(w)) score += 1;
      }
      return { p, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.p);
  }
}
