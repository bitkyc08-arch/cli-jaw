import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');
const routesSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');
const tuiApiSrc = fs.readFileSync(join(root, 'bin/commands/tui/api.ts'), 'utf8');
const contextSrc = fs.readFileSync(join(root, 'src/cli/command-context.ts'), 'utf8');

test('BEC-001: existing human output remains default for snapshot and screenshot', () => {
    assert.match(cliSrc, /console\.log\(`\$\{n\.ref\.padEnd/);
    assert.match(cliSrc, /values\.json \? JSON\.stringify\(r, null, 2\) : r\.path/);
});

test('BEC-002: existing click/type/tabs human messages remain available', () => {
    assert.match(cliSrc, /clicked \$\{ref\}/);
    assert.match(cliSrc, /typed into \$\{ref\}/);
    assert.match(cliSrc, /\$\{i \+ 1\}\. \$\{t\.title\}/);
});

test('BEC-003: browser CLI keeps auth headers for hardened read routes', () => {
    assert.match(cliSrc, /authHeaders\(\)/);
    assert.match(routesSrc, /\/api\/browser\/tabs', requireAuth/);
    assert.match(routesSrc, /\/api\/browser\/snapshot', requireAuth/);
    assert.match(routesSrc, /\/api\/browser\/text', requireAuth/);
});

test('BEC-004: TUI and command context browser consumers remain covered', () => {
    assert.match(tuiApiSrc, /authHeaders\(\)/);
    assert.match(tuiApiSrc, /getBrowserTabs: \(\) => api\('\/api\/browser\/tabs'\)/);
    assert.match(contextSrc, /browser\.listTabs/);
});

