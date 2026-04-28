import type { DashboardLifecycleResult } from './types.js';

export interface DashboardShutdownLifecycle {
    stopAll(): Promise<DashboardLifecycleResult[]>;
}

export interface DashboardShutdownPreviewProxy {
    close(): Promise<void>;
}

export interface DashboardShutdownServer {
    close(callback?: (error?: Error) => void): void;
}

export interface DashboardShutdownOptions {
    lifecycle: DashboardShutdownLifecycle;
    previewProxy: DashboardShutdownPreviewProxy;
    server: DashboardShutdownServer;
    exit?: (code: number) => void;
    log?: Pick<Console, 'error' | 'warn'>;
}

function closeServer(server: DashboardShutdownServer): Promise<Error | null> {
    return new Promise(resolve => {
        server.close(error => resolve(error || null));
    });
}

function warnLifecycleFailures(
    results: DashboardLifecycleResult[],
    log: Pick<Console, 'warn'>,
): void {
    for (const result of results) {
        if (result.ok) continue;
        log.warn(`[dashboard] failed to stop managed Jaw on port ${result.port}: ${result.message}`);
    }
}

export function createDashboardShutdown(options: DashboardShutdownOptions): () => Promise<void> {
    const exit = options.exit || ((code: number): never => process.exit(code));
    const log = options.log || console;
    let shutdownPromise: Promise<void> | null = null;

    return async (): Promise<void> => {
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = (async () => {
            try {
                const lifecycleResults = await options.lifecycle.stopAll();
                warnLifecycleFailures(lifecycleResults, log);
            } catch (error) {
                log.error(`[dashboard] failed to stop managed Jaw instances: ${(error as Error).message}`);
            }

            try {
                await options.previewProxy.close();
            } catch (error) {
                log.error(`[dashboard] failed to close preview proxy: ${(error as Error).message}`);
            }

            const serverError = await closeServer(options.server);
            if (serverError) {
                log.error(`[dashboard] failed to close manager server: ${serverError.message}`);
            }

            exit(0);
        })();

        return shutdownPromise;
    };
}
