import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(root, path), 'utf8');
}

function collectFiles(dir: string): string[] {
    const full = join(root, dir);
    const out: string[] = [];
    for (const name of readdirSync(full)) {
        const path = join(dir, name);
        const st = statSync(join(root, path));
        if (st.isDirectory()) out.push(...collectFiles(path));
        else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
    return out;
}

const tuiSourcePaths = [
    ...collectFiles('src/cli/tui'),
    ...collectFiles('bin/commands/tui'),
    'bin/commands/chat.ts',
];

function readTuiSources(): string {
    return tuiSourcePaths.map(path => `\n// ${path}\n${read(path)}`).join('\n');
}

test('TUI remains a jaw chat surface and does not consume Manager Code mode APIs directly', () => {
    const tuiSources = readTuiSources();

    assert.doesNotMatch(tuiSources, /\/api\/code\b/, 'TUI must not fetch Manager Code mode /api/code routes directly');
    assert.doesNotMatch(tuiSources, /src\/code-mode|CodeCanvas|CodeCommandPopup|CodeSessionList/, 'TUI must not import Manager Code workbench modules');
    assert.doesNotMatch(tuiSources, /code_child_exit|code_permission_request|code_available_commands_update/, 'JWC ACP Code events are Manager Code mode events, not TUI events');
});

test('TUI slash surface exposes generic cli-jaw controls but not a claimed JWC provider command', () => {
    const commands = read('src/cli/commands.ts');
    const runner = read('bin/commands/tui/slash-command-runner.ts');

    assert.match(commands, /name: 'model'[\s\S]*interfaces: \['cli', 'web', 'telegram', 'discord'\]/, 'generic /model is available to TUI through the CLI command registry');
    assert.match(commands, /name: 'settings'[\s\S]*interfaces: \['cli'\]/, 'TUI settings is a CLI-only command');
    assert.match(commands, /name: 'effort'[\s\S]*interfaces: \['cli', 'web'\]/, 'generic /effort exists for cli-jaw chat');
    assert.doesNotMatch(commands, /name: 'provider'/, 'TUI must not claim /provider parity until a real provider route exists');
    assert.match(runner, /getArgumentCompletionItems\('model', '', 'cli'/, 'no-arg /model opens the generic CLI model argument selector');
    assert.match(runner, /openSettingsScreen\(ctx\)/, 'TUI /settings opens the local settings screen rather than Manager Code popup UI');
});

test('TUI settings and monitor surfaces document their narrower ownership', () => {
    const settingsScreen = read('src/cli/tui/settings-screen.ts');
    const overlays = read('bin/commands/tui/overlays.ts');
    const events = read('src/cli/tui/events.ts');

    assert.match(settingsScreen, /Only supported local CLI\/TUI settings and real Web AI settings are shown\./, 'settings screen must state its narrow ownership');
    assert.match(settingsScreen, /Runtime Frame Behavior/, 'settings screen may describe runtime frame behavior as readonly');
    assert.doesNotMatch(settingsScreen, /JWC Provider|Code session|ACP permission/i, 'settings screen must not imply Code mode provider/session/permission ownership');
    assert.match(overlays, /\/api\/bgtask\?limit=10/, 'TUI bgtask overlay reads the shared background task API');
    assert.match(events, /case 'bgtask_update'/, 'TUI maps bgtask updates');
    assert.match(events, /case 'worker_stalled'[\s\S]*case 'worker_timeout'[\s\S]*case 'worker_disconnected'/, 'TUI maps worker warning signals only as warnings');
});
