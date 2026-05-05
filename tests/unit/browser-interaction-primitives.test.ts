import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionsSrc = fs.readFileSync(join(root, 'src/browser/actions.ts'), 'utf8');
const routesSrc = fs.readFileSync(join(root, 'src/routes/browser.ts'), 'utf8');
const cliSrc = fs.readFileSync(join(root, 'bin/commands/browser.ts'), 'utf8');

test('BIP-001: mutation primitives are implemented in action layer', () => {
    for (const fn of ['reload', 'resize', 'scroll', 'select', 'drag', 'mouseMove', 'mouseDown', 'mouseUp']) {
        assert.match(actionsSrc, new RegExp(`export async function ${fn}`));
    }
});

test('BIP-002: drag is ref-to-ref, not coordinate-to-coordinate', () => {
    assert.match(actionsSrc, /drag\(port: number, fromRef: string, toRef: string\)/);
    assert.match(actionsSrc, /from\.dragTo\(to\)/);
    assert.match(cliSrc, /case 'drag'/);
    assert.doesNotMatch(cliSrc, /drag <fromX>/);
});

test('BIP-003: move-mouse naming matches 30_browser command surface', () => {
    assert.match(cliSrc, /case 'move-mouse'/);
    assert.match(routesSrc, /case 'move-mouse'/);
    assert.doesNotMatch(cliSrc, /case 'mouse-move'/);
});

test('BIP-004: right click maps through click button option', () => {
    assert.match(cliSrc, /--right/);
    assert.match(cliSrc, /opts\.button = 'right'/);
    assert.match(actionsSrc, /function optionMouseButton/);
    assert.match(actionsSrc, /button: optionMouseButton\(opts\)/);
});
