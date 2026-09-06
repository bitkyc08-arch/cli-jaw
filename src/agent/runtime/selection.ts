import type { RuntimeTransport } from '../../shared/runtime-contract.js';

export const SWITCHABLE_NATIVE_CLIS = ['cursor', 'grok', 'claude'] as const;

export function isSwitchableNativeCli(cli: string): boolean {
    return SWITCHABLE_NATIVE_CLIS.some(value => value === cli);
}

export function resolveRuntimeTransport(value: unknown): RuntimeTransport {
    return value === 'native' ? 'native' : 'print';
}

export function isRuntimeTransport(value: unknown): value is RuntimeTransport {
    return value === 'native' || value === 'print';
}

export function runtimeSessionBucket(legacyBucket: string, transport: RuntimeTransport): string {
    return transport === 'native' ? 'native-v1:' + legacyBucket : legacyBucket;
}

export function isNativeSessionBucket(bucket: string): boolean {
    return bucket.startsWith('native-v1:');
}

/** Compiled adapter support, not binary availability or authentication proof. */
export function isNativeAdapterImplemented(cli: string): boolean {
    return cli === 'codex-app' || cli === 'pi' || cli === 'cursor' || cli === 'grok' || cli === 'claude';
}

/** Independent of main support; switchable workers are enabled only with ownership support. */
export function isNativeWorkerImplemented(cli: string): boolean {
    return cli === 'codex-app' || cli === 'pi';
}

export function runtimeSelectionStatus(cli: string, value: unknown) {
    const nativeAdapterImplemented = isNativeAdapterImplemented(cli);
    const transport: RuntimeTransport = !isSwitchableNativeCli(cli) && nativeAdapterImplemented
        ? 'native' : isSwitchableNativeCli(cli) ? resolveRuntimeTransport(value) : 'print';
    return { transport, nativeAdapterImplemented, nativeWorkerImplemented: isNativeWorkerImplemented(cli) };
}
