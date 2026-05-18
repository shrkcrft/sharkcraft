import {
  DEFAULT_SAFE_IMPORT_TIMEOUT_MS,
  safeImport,
  type SafeImportResult,
} from './safe-import.ts';

export interface IImportContext {
  readonly timeoutMs: number;
  size(): number;
  load<T = Record<string, unknown>>(filePath: string): Promise<SafeImportResult<T>>;
  hasSettled(filePath: string): boolean;
  entries(): IterableIterator<[string, SafeImportResult]>;
}

export interface IImportContextOptions {
  timeoutMs?: number;
}

class ImportContext implements IImportContext {
  readonly timeoutMs: number;
  private readonly _pending = new Map<string, Promise<SafeImportResult>>();
  private readonly _settled = new Map<string, SafeImportResult>();

  constructor(options: IImportContextOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SAFE_IMPORT_TIMEOUT_MS;
  }

  size(): number {
    return this._pending.size;
  }

  hasSettled(filePath: string): boolean {
    return this._settled.has(filePath);
  }

  async load<T = Record<string, unknown>>(filePath: string): Promise<SafeImportResult<T>> {
    const existing = this._pending.get(filePath);
    if (existing) return existing as unknown as Promise<SafeImportResult<T>>;
    const p = safeImport<T>(filePath, { timeoutMs: this.timeoutMs });
    const wrapped = p.then((r) => {
      this._settled.set(filePath, r as unknown as SafeImportResult);
      return r;
    });
    this._pending.set(filePath, wrapped as unknown as Promise<SafeImportResult>);
    return wrapped;
  }

  entries(): IterableIterator<[string, SafeImportResult]> {
    return this._settled.entries();
  }
}

export function createImportContext(options: IImportContextOptions = {}): IImportContext {
  return new ImportContext(options);
}
