export type StripUndefined<T extends object> = {
    [K in keyof T]: Exclude<T[K], undefined>;
};

export function stripUndefined<T extends object>(input: T): StripUndefined<T> {
    const out = {} as Record<string, unknown>;
    for (const key of Object.keys(input) as Array<keyof T & string>) {
        const value = input[key];
        if (value !== undefined) out[key] = value;
    }
    return out as StripUndefined<T>;
}

export function stripUndefinedAll<T extends object>(arr: readonly T[]): Array<StripUndefined<T>> {
    return arr.map(stripUndefined);
}
