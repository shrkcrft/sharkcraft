import * as nodePath from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { err, ok, type Result } from '../result/result.ts';
import { AppErrorImpl, ERROR_CODES, type AppError } from '../result/errors.ts';
import type {
  DirEntry,
  FileStat,
  IFileSystem,
  RemoveOptions,
  WriteOptions,
} from './file-system.ts';

export class BunFileSystem implements IFileSystem {
  private readonly _cwd: string;

  constructor(cwd?: string) {
    this._cwd = cwd ?? process.cwd();
  }

  cwd(): string {
    return this._cwd;
  }

  resolve(...parts: string[]): string {
    return nodePath.resolve(this._cwd, ...parts);
  }

  relative(from: string, to: string): string {
    return nodePath.relative(from, to);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  async isFile(path: string): Promise<boolean> {
    try {
      const st = statSync(path);
      return st.isFile();
    } catch {
      return false;
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      const st = statSync(path);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<Result<string, AppError>> {
    try {
      const text = await fs.readFile(path, 'utf8');
      return ok(text);
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.FILE_READ_ERROR,
          `Failed to read file: ${path}`,
          { details: { path }, cause: e },
        ),
      );
    }
  }

  async writeFile(
    path: string,
    contents: string,
    options: WriteOptions = {},
  ): Promise<Result<void, AppError>> {
    try {
      if (options.createDirs !== false) {
        await fs.mkdir(nodePath.dirname(path), { recursive: true });
      }
      if (options.overwrite === false && existsSync(path)) {
        return err(
          new AppErrorImpl(
            ERROR_CODES.TARGET_FILE_EXISTS,
            `Target file exists: ${path}`,
            { details: { path }, suggestion: 'Pass overwrite:true or use --force' },
          ),
        );
      }
      await fs.writeFile(path, contents, 'utf8');
      return ok(undefined);
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.FILE_WRITE_ERROR,
          `Failed to write file: ${path}`,
          { details: { path }, cause: e },
        ),
      );
    }
  }

  async ensureDir(path: string): Promise<Result<void, AppError>> {
    try {
      await fs.mkdir(path, { recursive: true });
      return ok(undefined);
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.IO_ERROR,
          `Failed to ensure directory: ${path}`,
          { details: { path }, cause: e },
        ),
      );
    }
  }

  async readDir(path: string): Promise<Result<DirEntry[], AppError>> {
    try {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return ok(
        entries.map((e) => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
        })),
      );
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.IO_ERROR,
          `Failed to read directory: ${path}`,
          { details: { path }, cause: e },
        ),
      );
    }
  }

  async remove(path: string, options: RemoveOptions = {}): Promise<Result<void, AppError>> {
    try {
      await fs.rm(path, { recursive: options.recursive ?? false, force: true });
      return ok(undefined);
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.IO_ERROR,
          `Failed to remove: ${path}`,
          { details: { path }, cause: e },
        ),
      );
    }
  }

  async stat(path: string): Promise<Result<FileStat, AppError>> {
    try {
      const st = await fs.stat(path);
      return ok({
        size: st.size,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        mtimeMs: st.mtimeMs,
      });
    } catch (e) {
      return err(
        new AppErrorImpl(
          ERROR_CODES.IO_ERROR,
          `Failed to stat: ${path}`,
          { details: { path }, cause: e },
        ),
      );
    }
  }
}

let defaultFs: IFileSystem | null = null;

export function getFileSystem(): IFileSystem {
  if (!defaultFs) defaultFs = new BunFileSystem();
  return defaultFs;
}

export function setFileSystem(fs: IFileSystem): void {
  defaultFs = fs;
}
