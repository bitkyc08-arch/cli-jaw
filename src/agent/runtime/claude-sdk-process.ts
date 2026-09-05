import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { ownProcess } from '../spawn/process-kill.js';

/** SDK transport ownership: stderr is drained, and close means observed child exit. */
export function createClaudeProcessOwner() {
    const children = new Set<ChildProcessWithoutNullStreams>();
    const exits: Promise<void>[] = [];
    let closing = false;
    let stderrBytes = 0;
    return {
        spawn(options: SpawnOptions): ChildProcessWithoutNullStreams {
            if (closing) throw new Error('claude_process_owner_closed');
            const child = spawn(options.command, options.args, {
                ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env,
                stdio: 'pipe', shell: false, windowsHide: true,
            });
            children.add(child);
            const owner = ownProcess(child);
            const consume = (chunk: Buffer) => { stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + chunk.length); };
            const abort = () => owner.terminate('cancel');
            child.stderr.on('data', consume);
            // SDK owns stdin/stdout parsing; a closed pipe must not become an unhandled error.
            const ioError = () => owner.terminate('startup-failed');
            child.stdin.on('error', ioError); child.stdout.on('error', ioError); child.stderr.on('error', ioError);
            options.signal.addEventListener('abort', abort, { once: true });
            if (options.signal.aborted) abort();
            exits.push(new Promise<void>(resolve => {
                child.once('error', () => owner.terminate('startup-failed'));
                child.once('close', () => {
                    children.delete(child); options.signal.removeEventListener('abort', abort);
                    child.stderr.off('data', consume);
                    child.stdin.off('error', ioError); child.stdout.off('error', ioError); child.stderr.off('error', ioError);
                    resolve();
                });
            }));
            return child;
        },
        terminate(): void {
            closing = true;
            for (const child of children) ownProcess(child).terminate('cancel');
        },
        async wait(): Promise<void> { await Promise.all(exits); },
        get stderrBytes() { return stderrBytes; },
        get activeCount() { return children.size; },
    };
}
