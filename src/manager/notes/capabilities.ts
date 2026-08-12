import { spawn } from 'node:child_process';
import { ownProcess, type OwnedProcessOptions } from '../../agent/spawn/process-kill.js';
import type { DashboardNotesCapabilities, NotesCapability } from '../types.js';

const COMMAND_TIMEOUT_MS = 750;

export type NotesCapabilitiesOptions = {
    spawnImpl?: typeof spawn;
    ownedProcessOptions?: OwnedProcessOptions;
};

function versionLine(output: string): string | undefined {
    return output.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
}

function checkCommand(command: string, args: string[], options: NotesCapabilitiesOptions): Promise<NotesCapability> {
    return new Promise(resolve => {
        const child = (options.spawnImpl ?? spawn)(command, args, { shell: false });
        const ownedChild = ownProcess(child, options.ownedProcessOptions);
        let output = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ownedChild.terminate('timeout');
            resolve({ available: false, command, reason: 'timeout' });
        }, COMMAND_TIMEOUT_MS);

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stderr.on('data', chunk => { output += String(chunk); });
        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ available: false, command, reason: error.message });
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) {
                const version = versionLine(output);
                resolve(version ? { available: true, command, version } : { available: true, command });
                return;
            }
            resolve({ available: false, command, reason: versionLine(output) || `exit ${code}` });
        });
    });
}

export async function detectNotesCapabilities(options: NotesCapabilitiesOptions = {}): Promise<DashboardNotesCapabilities> {
    const [ripgrep, git, pdf] = await Promise.all([
        checkCommand('rg', ['--version'], options),
        checkCommand('git', ['--version'], options),
        checkCommand('pdftotext', ['-v'], options),
    ]);
    return {
        ripgrep,
        git,
        fileWatching: { available: true, provider: 'fs.watch' },
        pdf,
    };
}
