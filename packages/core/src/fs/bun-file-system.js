import * as nodePath from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { err, ok } from "../result/result.js";
import { AppErrorImpl, ERROR_CODES } from "../result/errors.js";
export class BunFileSystem {
    _cwd;
    constructor(cwd) {
        this._cwd = cwd ?? process.cwd();
    }
    cwd() {
        return this._cwd;
    }
    resolve(...parts) {
        return nodePath.resolve(this._cwd, ...parts);
    }
    relative(from, to) {
        return nodePath.relative(from, to);
    }
    async exists(path) {
        return existsSync(path);
    }
    async isFile(path) {
        try {
            const st = statSync(path);
            return st.isFile();
        }
        catch {
            return false;
        }
    }
    async isDirectory(path) {
        try {
            const st = statSync(path);
            return st.isDirectory();
        }
        catch {
            return false;
        }
    }
    async readFile(path) {
        try {
            const text = await fs.readFile(path, 'utf8');
            return ok(text);
        }
        catch (e) {
            return err(new AppErrorImpl(ERROR_CODES.FILE_READ_ERROR, `Failed to read file: ${path}`, { details: { path }, cause: e }));
        }
    }
    async writeFile(path, contents, options = {}) {
        try {
            if (options.createDirs !== false) {
                await fs.mkdir(nodePath.dirname(path), { recursive: true });
            }
            if (options.overwrite === false && existsSync(path)) {
                return err(new AppErrorImpl(ERROR_CODES.TARGET_FILE_EXISTS, `Target file exists: ${path}`, { details: { path }, suggestion: 'Pass overwrite:true or use --force' }));
            }
            await fs.writeFile(path, contents, 'utf8');
            return ok(undefined);
        }
        catch (e) {
            return err(new AppErrorImpl(ERROR_CODES.FILE_WRITE_ERROR, `Failed to write file: ${path}`, { details: { path }, cause: e }));
        }
    }
    async ensureDir(path) {
        try {
            await fs.mkdir(path, { recursive: true });
            return ok(undefined);
        }
        catch (e) {
            return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, `Failed to ensure directory: ${path}`, { details: { path }, cause: e }));
        }
    }
    async readDir(path) {
        try {
            const entries = await fs.readdir(path, { withFileTypes: true });
            return ok(entries.map((e) => ({
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile(),
                isSymlink: e.isSymbolicLink(),
            })));
        }
        catch (e) {
            return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, `Failed to read directory: ${path}`, { details: { path }, cause: e }));
        }
    }
    async remove(path, options = {}) {
        try {
            await fs.rm(path, { recursive: options.recursive ?? false, force: true });
            return ok(undefined);
        }
        catch (e) {
            return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, `Failed to remove: ${path}`, { details: { path }, cause: e }));
        }
    }
    async stat(path) {
        try {
            const st = await fs.stat(path);
            return ok({
                size: st.size,
                isFile: st.isFile(),
                isDirectory: st.isDirectory(),
                mtimeMs: st.mtimeMs,
            });
        }
        catch (e) {
            return err(new AppErrorImpl(ERROR_CODES.IO_ERROR, `Failed to stat: ${path}`, { details: { path }, cause: e }));
        }
    }
}
let defaultFs = null;
export function getFileSystem() {
    if (!defaultFs)
        defaultFs = new BunFileSystem();
    return defaultFs;
}
export function setFileSystem(fs) {
    defaultFs = fs;
}
