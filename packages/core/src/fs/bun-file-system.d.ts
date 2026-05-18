import { type Result } from '../result/result.ts';
import { type AppError } from '../result/errors.ts';
import type { DirEntry, FileStat, IFileSystem, RemoveOptions, WriteOptions } from './file-system.ts';
export declare class BunFileSystem implements IFileSystem {
    private readonly _cwd;
    constructor(cwd?: string);
    cwd(): string;
    resolve(...parts: string[]): string;
    relative(from: string, to: string): string;
    exists(path: string): Promise<boolean>;
    isFile(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    readFile(path: string): Promise<Result<string, AppError>>;
    writeFile(path: string, contents: string, options?: WriteOptions): Promise<Result<void, AppError>>;
    ensureDir(path: string): Promise<Result<void, AppError>>;
    readDir(path: string): Promise<Result<DirEntry[], AppError>>;
    remove(path: string, options?: RemoveOptions): Promise<Result<void, AppError>>;
    stat(path: string): Promise<Result<FileStat, AppError>>;
}
export declare function getFileSystem(): IFileSystem;
export declare function setFileSystem(fs: IFileSystem): void;
//# sourceMappingURL=bun-file-system.d.ts.map