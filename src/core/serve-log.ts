import fs from 'node:fs';
import path from 'node:path';
import type { Writable } from 'node:stream';

export const SERVE_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface ServeLogOptions {
    maxBytes?: number;
}

export interface ServeLogHandle {
    logPath: string;
    close(): Promise<void>;
}

function rotateAtCap(logPath: string, maxBytes: number): void {
    let size = 0;
    try {
        size = fs.statSync(logPath).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (size < maxBytes) return;

    const rotatedPath = `${logPath}.1`;
    fs.rmSync(rotatedPath, { force: true });
    fs.renameSync(logPath, rotatedPath);
}

/**
 * Tee the server's inherited stdout/stderr into an instance-owned append log.
 * The original stream methods remain the source of terminal/launcher output;
 * this adds one file sink without echoing anything back to either stream.
 */
export function openServeLog(
    jawHome: string,
    options: ServeLogOptions = {},
    stdout: Writable = process.stdout,
    stderr: Writable = process.stderr,
): ServeLogHandle {
    const maxBytes = options.maxBytes ?? SERVE_LOG_MAX_BYTES;
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('serve log maxBytes must be positive');

    const logDir = path.join(jawHome, 'logs');
    const logPath = path.join(logDir, 'serve.log');
    fs.mkdirSync(logDir, { recursive: true });
    rotateAtCap(logPath, maxBytes);

    const originalStdoutWrite = stdout.write.bind(stdout);
    const originalStderrWrite = stderr.write.bind(stderr);
    const file = fs.createWriteStream(logPath, { flags: 'a' });
    // A late disk error must not turn logging into an uncaught server crash.
    file.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        originalStderrWrite(`[serve-log] ${message}\n`);
    });

    const tee = (original: typeof stdout.write) => function write(
        chunk: unknown,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
    ): boolean {
        if (typeof encodingOrCallback === 'string') {
            file.write(chunk as string | Uint8Array, encodingOrCallback);
        } else {
            file.write(chunk as string | Uint8Array);
        }
        return original(chunk as never, encodingOrCallback as never, callback as never);
    };

    stdout.write = tee(originalStdoutWrite) as typeof stdout.write;
    stderr.write = tee(originalStderrWrite) as typeof stderr.write;

    let closed = false;
    return {
        logPath,
        close: async () => {
            if (closed) return;
            closed = true;
            stdout.write = originalStdoutWrite as typeof stdout.write;
            stderr.write = originalStderrWrite as typeof stderr.write;
            await new Promise<void>((resolve, reject) => {
                file.end((error?: Error | null) => error ? reject(error) : resolve());
            });
        },
    };
}
