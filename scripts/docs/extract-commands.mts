import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import ts from 'typescript';
import { CLI_KEYS } from '../../src/cli/registry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');
const commandsPath = join(root, 'src/cli/commands.ts');

const SURFACES = ['cli', 'web', 'telegram', 'discord'] as const;
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
]);

type SlashSurface = typeof SURFACES[number];
type CapabilityValue = 'full' | 'readonly' | 'hidden' | 'blocked' | string;

export interface CommandInventoryEntry {
    name: string;
    interfaces: string[];
    hidden: boolean;
    cli: boolean;
    web: boolean;
    telegram: boolean;
    discord: boolean;
    cmdline: boolean;
    description?: string;
}

export interface CommandsInventory {
    commands: CommandInventoryEntry[];
    totals: {
        total: number;
        nonHidden: number;
        cliVisible: number;
        webVisible: number;
        telegramVisible: number;
        discordVisible: number;
        cmdlineVisible: number;
    };
    runtimes: {
        keys: string[];
        count: number;
    };
}

interface ParsedCommand {
    name: string;
    interfaces: string[];
    category?: string;
    hidden: boolean;
    description?: string;
    capability: Partial<Record<string, CapabilityValue>>;
}

function propertyNameText(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
}

function objectProperty(node: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const propName = propertyNameText(prop.name);
        if (propName === name) return prop.initializer;
    }
    return null;
}

function stringProperty(node: ts.ObjectLiteralExpression, name: string): string | undefined {
    const value = objectProperty(node, name);
    if (!value || !ts.isStringLiteralLike(value)) return undefined;
    return value.text;
}

function booleanProperty(node: ts.ObjectLiteralExpression, name: string): boolean {
    const value = objectProperty(node, name);
    if (!value) return false;
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    throw new Error(`COMMANDS.${name} must be a boolean literal`);
}

function stringArrayProperty(node: ts.ObjectLiteralExpression, name: string): string[] {
    const value = objectProperty(node, name);
    if (!value || !ts.isArrayLiteralExpression(value)) return [];
    return value.elements.map(element => {
        if (!ts.isStringLiteralLike(element)) {
            throw new Error(`COMMANDS.${name} must contain only string literals`);
        }
        return element.text;
    });
}

function capabilityProperty(node: ts.ObjectLiteralExpression): Partial<Record<string, CapabilityValue>> {
    const value = objectProperty(node, 'capability');
    if (!value) return {};
    if (!ts.isObjectLiteralExpression(value)) throw new Error('COMMANDS.capability must be an object literal');

    const out: Partial<Record<string, CapabilityValue>> = {};
    for (const prop of value.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = propertyNameText(prop.name);
        const initializer = prop.initializer;
        if (!key || !ts.isStringLiteralLike(initializer)) continue;
        out[key] = initializer.text;
    }
    return out;
}

function findCommandsArray(sourceFile: ts.SourceFile): ts.ArrayLiteralExpression {
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'COMMANDS') continue;
            if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
                throw new Error('COMMANDS must be initialized with an array literal');
            }
            return declaration.initializer;
        }
    }
    throw new Error('Unable to find COMMANDS array in src/cli/commands.ts');
}

function parseCommandObject(node: ts.ObjectLiteralExpression): ParsedCommand {
    const name = stringProperty(node, 'name');
    if (!name) throw new Error('COMMANDS entry is missing a string name');

    const description = stringProperty(node, 'desc');
    return {
        name,
        interfaces: stringArrayProperty(node, 'interfaces'),
        category: stringProperty(node, 'category'),
        hidden: booleanProperty(node, 'hidden'),
        ...(description === undefined ? {} : { description }),
        capability: capabilityProperty(node),
    };
}

function visibleOnSlashSurface(command: ParsedCommand, surface: SlashSurface): boolean {
    if (command.hidden) return false;
    if (!command.interfaces.includes(surface)) return false;
    const capability = command.capability[surface];
    if (capability !== undefined) return capability !== 'hidden' && capability !== 'blocked';
    return true;
}

function visibleOnCmdline(command: ParsedCommand): boolean {
    return !CMDLINE_HIDDEN.has(command.name) && command.category !== 'workflow';
}

async function parseCommands(): Promise<ParsedCommand[]> {
    const source = await readFile(commandsPath, 'utf8');
    const sourceFile = ts.createSourceFile(commandsPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const commandsArray = findCommandsArray(sourceFile);
    return commandsArray.elements.map(element => {
        if (!ts.isObjectLiteralExpression(element)) throw new Error('COMMANDS must contain only object literals');
        return parseCommandObject(element);
    });
}

export async function extractCommands(): Promise<CommandsInventory> {
    const parsedCommands = await parseCommands();
    const commands = parsedCommands
        .map(command => ({
            name: command.name,
            interfaces: [...command.interfaces].sort(),
            hidden: command.hidden,
            cli: visibleOnSlashSurface(command, 'cli'),
            web: visibleOnSlashSurface(command, 'web'),
            telegram: visibleOnSlashSurface(command, 'telegram'),
            discord: visibleOnSlashSurface(command, 'discord'),
            cmdline: visibleOnCmdline(command),
            ...(command.description === undefined ? {} : { description: command.description }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

    return {
        commands,
        totals: {
            total: commands.length,
            nonHidden: commands.filter(command => !command.hidden).length,
            cliVisible: commands.filter(command => command.cli).length,
            webVisible: commands.filter(command => command.web).length,
            telegramVisible: commands.filter(command => command.telegram).length,
            discordVisible: commands.filter(command => command.discord).length,
            cmdlineVisible: commands.filter(command => command.cmdline).length,
        },
        runtimes: {
            keys: [...CLI_KEYS].sort(),
            count: CLI_KEYS.length,
        },
    };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
    const inventory = await extractCommands();
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}
