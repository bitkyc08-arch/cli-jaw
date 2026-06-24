#!/usr/bin/env node

import { buildPrePromptContextHook, type ContextHookInput, type ContextHookScope } from '../../src/prompt/context-hooks.js';
import { shouldShowHelp, printAndExit } from '../helpers/help.js';

if (shouldShowHelp(process.argv)) printAndExit(`
  jaw hooks inspect — inspect read-only pre-prompt context injection

  Usage:
    jaw hooks inspect [--scope main|heartbeat] [--job NAME] [--cli NAME] [--fresh] [--json]

  Environment:
    CLI_JAW_PRE_PROMPT_HOOKS=0   Disable all pre-prompt context hooks
`);

function valueAfter(flag: string): string | undefined {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const subcommand = process.argv[3] || 'inspect';
if (subcommand !== 'inspect') {
    console.error(`Unknown hooks subcommand: ${subcommand}`);
    process.exitCode = 1;
} else {
    const rawScope = valueAfter('--scope') || 'main';
    if (rawScope !== 'main' && rawScope !== 'heartbeat') {
        console.error(`Invalid scope: ${rawScope}`);
        process.exitCode = 1;
    } else {
        const scope = rawScope as ContextHookScope;
        const job = valueAfter('--job') || 'inspect';
        const currentPrompt = scope === 'heartbeat' ? `[heartbeat:${job}] inspect` : 'inspect';
        const input: ContextHookInput = {
            currentPrompt,
            freshSession: process.argv.includes('--fresh'),
        };
        const activeCli = valueAfter('--cli');
        if (activeCli) input.activeCli = activeCli;
        const result = buildPrePromptContextHook(input, { log: false });

        if (process.argv.includes('--json')) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(`Config: ${result.report.configPath}`);
            console.log(`Status: ${result.report.status}`);
            console.log(`Scope: ${result.report.scope}${result.report.job ? ` (${result.report.job})` : ''}`);
            console.log(`Sources: ${result.report.sources.filter(source => source.status === 'included').length}/${result.report.sources.length}`);
            console.log(`Size: ${result.report.totalChars} chars in ${result.report.durationMs.toFixed(1)} ms`);
            for (const source of result.report.sources) {
                console.log(`  - ${source.id}: ${source.status}${source.detail ? ` (${source.detail})` : ''}`);
            }
            if (result.block) console.log(`\n${result.block}`);
        }
    }
}
