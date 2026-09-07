import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCommands } from '../../scripts/docs/extract-commands.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const commandsPath = join(root, 'src/cli/commands.ts');

const CMDLINE_HIDDEN = new Set([
    'help',
    'clear',
    'model',
    'cli',
    'fallback',
    'status',
    'reset',
    'skill',
    'employee',
    'mcp',
    'memory',
    'browser',
    'prompt',
    'version',
    'stop',
    'approve',
    'deny',
]);

interface RegexCommand {
    name: string;
    body: string;
    category: string;
    hidden: boolean;
    interfaces: string[];
}

function read(path: string): string {
    return readFileSync(path, 'utf8');
}

function commandBodies(source: string): RegexCommand[] {
    return source
        .split('\n')
        .filter(line => line.includes("{ name: '"))
        .map(line => {
            const name = line.match(/\{\s*name:\s*'([^']+)'/)?.[1];
            const body = line;
            assert.ok(name, 'command regex should capture a name');

            const category = body.match(/category:\s*'([^']+)'/)?.[1] ?? '';
            const interfacesRaw = body.match(/interfaces:\s*\[([^\]]*)\]/)?.[1] ?? '';
            const interfaces = [...interfacesRaw.matchAll(/'([^']+)'/g)].map(interfaceMatch => {
                const iface = interfaceMatch[1];
                assert.ok(iface, `interface regex should capture a value for /${name}`);
                return iface;
            });

            return {
                name,
                body,
                category,
                hidden: /\bhidden:\s*true\b/.test(body),
                interfaces,
            };
        });
}

function hasHiddenCapability(command: RegexCommand, surface: string): boolean {
    const capabilityMatch = command.body.match(/capability:\s*\{([\s\S]*?)\}/);
    if (!capabilityMatch) return false;
    const capabilityBody = capabilityMatch[1] ?? '';
    const escapedSurface = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escapedSurface}:\\s*'(hidden|blocked)'`).test(capabilityBody);
}

function surfaceVisible(command: RegexCommand, surface: string): boolean {
    return !command.hidden && command.interfaces.includes(surface) && !hasHiddenCapability(command, surface);
}

function regexTotals(): {
    total: number;
    nonHidden: number;
    cliVisible: number;
    webVisible: number;
    telegramVisible: number;
    discordVisible: number;
    cmdlineVisible: number;
} {
    const commands = commandBodies(read(commandsPath));
    return {
        total: commands.length,
        nonHidden: commands.filter(command => !command.hidden).length,
        cliVisible: commands.filter(command => surfaceVisible(command, 'cli')).length,
        webVisible: commands.filter(command => surfaceVisible(command, 'web')).length,
        telegramVisible: commands.filter(command => surfaceVisible(command, 'telegram')).length,
        discordVisible: commands.filter(command => surfaceVisible(command, 'discord')).length,
        cmdlineVisible: commands.filter(command => !CMDLINE_HIDDEN.has(command.name) && command.category !== 'workflow').length,
    };
}

test('docs commands extractor returns stable sorted commands and live totals', async () => {
    const inventory = await extractCommands();
    const names = inventory.commands.map(command => command.name);

    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'commands should be sorted by name');
    assert.deepEqual(inventory.totals, regexTotals(), 'extractor totals should match independent source recount');
});

test('docs commands extractor tracks hidden slash commands and runtime keys', async () => {
    const inventory = await extractCommands();
    const fileCommand = inventory.commands.find(command => command.name === 'file');

    assert.ok(fileCommand, '/file should be present in command inventory');
    assert.equal(fileCommand.hidden, true, '/file should stay hidden');
    assert.equal(inventory.runtimes.keys.includes('jwc'), false, 'retired jwc must not be an executable runtime key');
    assert.ok(inventory.runtimes.keys.includes('codex-app'), 'runtime keys should include supported codex-app');
    assert.equal(inventory.runtimes.count, inventory.runtimes.keys.length, 'runtime count should match keys length');
});
