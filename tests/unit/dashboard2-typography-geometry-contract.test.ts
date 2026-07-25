// 260726 wp12 S1 — line-heights that are also layout constants.
//
// Most line-heights are typography and can be retuned freely. A few are not:
// JavaScript reads or assumes them, so changing one side alone breaks geometry
// with no visual warning at the edit site.
//
//   --lh-code-row   pairs with ROW_HEIGHT in ToolDetailLineWindow. The
//                   virtualiser multiplies it by the line index to place rows;
//                   if CSS renders 22px rows while JS positions on a 20px grid,
//                   scroll position drifts further the longer the output.
//
//   --lh-composer-row  feeds the textarea auto-grow. Composer clamps
//                   scrollHeight between 42 and 180px, and 42 is exactly two
//                   21px rows. Change the row height and the collapsed composer
//                   is no longer a clean two lines.
//
// The point is not that these values are sacred, but that they cannot be
// changed on one side only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function token(name: string): number {
    const source = read('public/dashboard2/src/styles/tokens-v4.css');
    const match = source.match(new RegExp(`${name}\\s*:\\s*([0-9.]+)px`));
    assert.ok(match, `${name} must be declared in tokens-v4.css`);
    return Number(match[1]);
}

test('--lh-code-row matches the virtualiser row height', () => {
    const source = read('public/dashboard2/src/turn-stream/detail/ToolDetailLineWindow.tsx');
    const match = source.match(/const ROW_HEIGHT = (\d+)/);
    assert.ok(match, 'ToolDetailLineWindow must declare ROW_HEIGHT');

    assert.equal(
        token('--lh-code-row'),
        Number(match[1]),
        'the tool-detail virtualiser positions rows on this grid; a mismatch drifts scroll position',
    );
});

test('the composer minimum height is a whole number of rows', () => {
    const source = read('public/dashboard2/src/chat/composer/Composer.tsx');
    const match = source.match(/Math\.max\((\d+), input\.scrollHeight\)/);
    assert.ok(match, 'Composer must clamp its auto-grow height');

    const minHeight = Number(match[1]);
    const row = token('--lh-composer-row');
    assert.equal(
        minHeight % row,
        0,
        `the collapsed composer (${minHeight}px) must be an exact multiple of its row height (${row}px)`,
    );
});

test('every scale step declares both a size and a line-height', () => {
    const source = read('public/dashboard2/src/styles/tokens-v4.css');
    const steps = [...source.matchAll(/--fs-([a-z0-9]+)\s*:/g)].map(m => m[1]);
    assert.ok(steps.length >= 9, 'the scale should have nine steps');

    const missing = steps.filter(step => !new RegExp(`--lh-${step}\\s*:`).test(source));
    assert.deepEqual(missing, [], 'a size step without a paired line-height invites a literal');
});
