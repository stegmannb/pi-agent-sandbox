export function captureSources(entry: string): { path: string; sha256: string }[];
export function captureScopes(refs: { path: string; sha256: string }[]): [string, string | null][];

export function nativeEntryIsObserved(url: string, receipt: unknown): boolean;
