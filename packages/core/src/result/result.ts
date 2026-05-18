import { AppErrorImpl, ERROR_CODES, type AppError } from './errors.ts';

export type Result<T, E = AppError> = ResultOk<T> | ResultErr<E>;

export interface ResultOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ResultErr<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok<T>(value: T): ResultOk<T> {
  return { ok: true, value };
}

export function err<E>(error: E): ResultErr<E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is ResultOk<T> {
  return r.ok === true;
}

export function isErr<T, E>(r: Result<T, E>): r is ResultErr<E> {
  return r.ok === false;
}

export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw r.error instanceof Error ? r.error : new Error(JSON.stringify(r.error));
}

export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

export function flatMap<T, U, E>(r: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

export async function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, AppError>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.UNKNOWN,
        e instanceof Error ? e.message : String(e),
        { cause: e },
      ),
    );
  }
}

export function trySync<T>(fn: () => T): Result<T, AppError> {
  try {
    return ok(fn());
  } catch (e) {
    return err(
      new AppErrorImpl(
        ERROR_CODES.UNKNOWN,
        e instanceof Error ? e.message : String(e),
        { cause: e },
      ),
    );
  }
}
