import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const commandsSrc = fs.readFileSync(join(root, 'src/cli/commands.ts'), 'utf8');
const searchHandlerSrc = fs.readFileSync(join(root, 'src/cli/handlers-search.ts'), 'utf8');
const searchWorkflowSrc = fs.readFileSync(join(root, 'src/workflows/search.ts'), 'utf8');
const cliRootSrc = fs.readFileSync(join(root, 'bin/cli-jaw.ts'), 'utf8');

test('/search slash command is registered as a requirements workflow', () => {
    assert.match(commandsSrc, /name: 'search'/);
    assert.match(commandsSrc, /descKey: 'cmd\.workflow\.search\.desc'/);
    assert.match(commandsSrc, /tgDescKey: 'cmd\.workflow\.search\.tg_desc'/);
    assert.match(commandsSrc, /phase: 'requirements'/);
    assert.match(commandsSrc, /handler: searchWorkflowHandler/);
    assert.match(commandsSrc, /interfaces: \['cli', 'web', 'telegram', 'discord'\]/);
});

test('/search handler stays thin and delegates prompt policy', () => {
    assert.match(searchHandlerSrc, /buildSearchSteerPrompt\(\{ query \}\)/);
    assert.match(searchHandlerSrc, /fire|submitMessage/);
    assert.doesNotMatch(searchHandlerSrc, /adaptiveFetch|browser fetch <url>|public endpoint/i);
});

test('/search steer prompt routes through search skill and browser-command boundary', () => {
    assert.match(searchWorkflowSrc, /active search skill/);
    assert.match(searchWorkflowSrc, /Command boundary/);
    assert.match(searchWorkflowSrc, /command-specific report shape/);
    assert.match(searchWorkflowSrc, /source-class routing/);
    assert.match(searchWorkflowSrc, /rewrite the request into 1-3 focused keyword queries/);
    assert.match(searchWorkflowSrc, /candidate URLs/);
    assert.match(searchWorkflowSrc, /cli-jaw browser fetch <url> --json/);
    assert.match(searchWorkflowSrc, /open.*text.*get-dom.*snapshot/s);
    assert.match(searchWorkflowSrc, /raw natural-language queries/);
    assert.match(searchWorkflowSrc, /known source classes/);
    assert.match(searchWorkflowSrc, /model-gated parallel research/);
    assert.match(searchWorkflowSrc, /official, community, realtime, and fetch\/browser verification/);
    assert.match(searchWorkflowSrc, /evidence_status/);
});

test('/search v1 is slash-only and does not add a root jaw search command', () => {
    assert.doesNotMatch(cliRootSrc, /case 'search'/);
    assert.equal(fs.existsSync(join(root, 'bin/commands/search.ts')), false);
});
