export declare function deepFreeze<T>(value: T): Readonly<T>;
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function merge<A extends Record<string, unknown>, B extends Record<string, unknown>>(a: A, b: B): A & B;
export declare function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K>;
export declare function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K>;
export declare function uniqueBy<T, K>(items: readonly T[], keyFn: (item: T) => K): T[];
export declare function groupBy<T, K extends string | number>(items: readonly T[], keyFn: (item: T) => K): Record<K, T[]>;
//# sourceMappingURL=object-utils.d.ts.map