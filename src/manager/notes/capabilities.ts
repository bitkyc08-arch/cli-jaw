import { spawn } from 'node:child_process';
import type { DashboardNotesCapabilities, NotesCapability } from '../types.js';

const COMMAND_TIMEOUT_MS = 750;

function versionLine(output: string): string | undefined {
    return output.split(/\r?\n/u).map(line => line.trim()).find(Boolean);
}

function checkCommand(command: string, args: string[]): Promise<NotesCapability> {
    return new Promise(resolve => {
        const child = spawn(command, args, { shell: false });
        let output = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
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

export async function detectNotesCapabilities(): Promise<DashboardNotesCapabilities> {
    const [ripgrep, git, pdf] = await Promise.all([
        checkCommand('rg', ['--version']),
        checkCommand('git', ['--version']),
        checkCommand('pdftotext', ['-v']),
    ]);
    return {
        ripgrep,
        git,
        fileWatching: { available: true, provider: 'fs.watch' },
        pdf,
    };
}
