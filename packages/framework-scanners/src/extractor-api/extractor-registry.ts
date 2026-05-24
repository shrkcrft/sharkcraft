import type { IFrameworkExtractor } from './framework-extractor.ts';

/**
 * Registry of framework extractors. The runner registers the built-in
 * extractors at startup; pack-contributed extractors can register
 * later via `register(...)`.
 */
export class FrameworkExtractorRegistry {
  private readonly byName = new Map<string, IFrameworkExtractor>();

  register(extractor: IFrameworkExtractor): void {
    if (this.byName.has(extractor.framework)) {
      throw new Error(`framework extractor already registered: ${extractor.framework}`);
    }
    this.byName.set(extractor.framework, extractor);
  }

  list(): readonly IFrameworkExtractor[] {
    return [...this.byName.values()].sort((a, b) => a.framework.localeCompare(b.framework));
  }

  applicable(file: { path: string; content: string }): readonly IFrameworkExtractor[] {
    return this.list().filter((e) => {
      try {
        return e.fileMatches(file);
      } catch {
        return false;
      }
    });
  }

  has(framework: string): boolean {
    return this.byName.has(framework);
  }

  get(framework: string): IFrameworkExtractor | undefined {
    return this.byName.get(framework);
  }

  size(): number {
    return this.byName.size;
  }
}
