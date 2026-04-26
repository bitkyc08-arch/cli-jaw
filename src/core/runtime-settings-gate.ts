let inFlightCount = 0;
let inFlightPromise: Promise<void> | null = null;
let resolveInFlight: (() => void) | null = null;

export function beginRuntimeSettingsMutation(): () => void {
    if (!inFlightPromise) {
        inFlightPromise = new Promise<void>((resolve) => {
            resolveInFlight = resolve;
        });
    }
    inFlightCount += 1;
    let finished = false;
    return () => {
        if (finished) return;
        finished = true;
        inFlightCount = Math.max(0, inFlightCount - 1);
        if (inFlightCount === 0) {
            const resolve = resolveInFlight;
            inFlightPromise = null;
            resolveInFlight = null;
            resolve?.();
        }
    };
}

export function isRuntimeSettingsMutationInFlight(): boolean {
    return !!inFlightPromise;
}

export async function waitForRuntimeSettingsIdle(): Promise<void> {
    const pending = inFlightPromise;
    if (pending) await pending;
}

export function resetRuntimeSettingsGateForTest(): void {
    inFlightCount = 0;
    const resolve = resolveInFlight;
    inFlightPromise = null;
    resolveInFlight = null;
    resolve?.();
}
