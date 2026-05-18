import type { Result } from '../result/result.ts';
import type { AppError } from '../result/errors.ts';
export interface DirEntry {
    name: string;
    isDirectory: boolean;
    isFile: boolean;
    isSymlink: boolean;
}
export interface IFileSystem {
    exists(path: string): Promise<boolean>;
    isFile(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    readFile(path: string): Promise<Result<string, AppError>>;
    writeFile(path: string, contents: string, options?: WriteOptions): Promise<Result<void, AppError>>;
    ensureDir(path: string): Promise<Result<void, AppError>>;
    readDir(path: string): Promise<Result<DirEntry[], AppError>>;
    remove(path: string, options?: RemoveOptions): Promise<Result<void, AppError>>;
    stat(path: string): Promise<Result<FileStat, AppError>>;
    cwd(): string;
    resolve(...parts: string[]): string;
    relative(from: string, to: string): string;
}
export interface WriteOptions {
    overwrite?: boolean;
    createDirs?: boolean;
}
export interface RemoveOptions {
    recursive?: boolean;
}
export interface FileStat {
    size: number;
    isFile: boolean;
    isDirectory: boolean;
    mtimeMs: number;
}
//# sourceMappingURL=file-system.d.ts.map