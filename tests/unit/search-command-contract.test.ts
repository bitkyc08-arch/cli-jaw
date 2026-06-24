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
    // The steer prompt was deliberately slimmed to point at the skills rather than
    // inline the workflow. Assert it routes to the search skill, crosses the
    // browser-command boundary, and carries the report-format contract.
    assert.match(searchWorkflowSrc, /User invoked \/search/);
    assert.match(searchWorkflowSrc, /MUST READ before searching/);
    assert.match(searchWorkflowSrc, /skills\/search\/SKILL\.md/);
    assert.match(searchWorkflowSrc, /skills\/browser\/SKILL\.md/);
    assert.match(searchWorkflowSrc, /Known URL Reader/);
    assert.match(searchWorkflowSrc, /Adaptive-fetch ladder/);
    assert.match(searchWorkflowSrc, /cli-jaw browser fetch <url>/);
    assert.match(searchWorkflowSrc, /Report format/);
    assert.match(searchWorkflowSrc, /focused_queries/);
    assert.match(searchWorkflowSrc, /evidence_status/);
});

test('/search v1 is slash-only and does not add a root jaw search command', () => {
    assert.doesNotMatch(cliRootSrc, /case 'search'/);
    assert.equal(fs.existsSync(join(root, 'bin/commands/search.ts')), false);
});
