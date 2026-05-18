import { type AppError } from './errors.ts';
export type Result<T, E = AppError> = ResultOk<T> | ResultErr<E>;
export interface ResultOk<T> {
    readonly ok: true;
    readonly value: T;
}
export interface ResultErr<E> {
    readonly ok: false;
    readonly error: E;
}
export declare function ok<T>(value: T): ResultOk<T>;
export declare function err<E>(error: E): ResultErr<E>;
export declare function isOk<T, E>(r: Result<T, E>): r is ResultOk<T>;
export declare function isErr<T, E>(r: Result<T, E>): r is ResultErr<E>;
export declare function unwrap<T, E>(r: Result<T, E>): T;
export declare function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E>;
export declare function flatMap<T, U, E>(r: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E>;
export declare function tryAsync<T>(fn: () => Promise<T>): Promise<Result<T, AppError>>;
export declare function trySync<T>(fn: () => T): Result<T, AppError>;
//# sourceMappingURL=result.d.ts.map