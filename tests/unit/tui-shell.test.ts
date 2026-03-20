import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupScrollRegion, ensureSpaceBelow, resolveShellLayout, setupScrollRegion } from '../../src/cli/tui/shell.ts';

function withMockedStdout(fn: () => void) {
    const originalRows = process.stdout.rows;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const writes: string[] = [];

    Object.defineProperty(process.stdout, 'rows', {
        configurable: true,
        value: 30,
    });
    process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
    }) as typeof process.stdout.write;

    try {
        fn();
    } finally {
        process.stdout.write = originalWrite as typeof process.stdout.write;
        Object.defineProperty(process.stdout, 'rows', {
            configurable: true,
            value: originalRows,
        });
    }

    return writes;
}

test('setupScrollRegion writes scroll region, divider, footer, and cursor restore in order', () => {
    const writes = withMockedStdout(() => {
        setupScrollRegion('  footer', '  divider');
    });

    assert.deepEqual(writes, [
        '\x1b[1;28r',
        '\x1b[29;1H\x1b[2K  divider',
        '\x1b[30;1H\x1b[2K  footer',
        '\x1b[28;1H',
    ]);
});

test('cleanupScrollRegion resets the scroll region and drops the cursor to the bottom row', () => {
    const writes = withMockedStdout(() => {
        cleanupScrollRegion();
    });

    assert.deepEqual(writes, [
        '\x1b[1;30r',
        '\x1b[30;1H\n',
    ]);
});

test('ensureSpaceBelow emits natural scroll newlines and restores cursor upward once', () => {
    const writes = withMockedStdout(() => {
        ensureSpaceBelow(3);
    });

    assert.deepEqual(writes, [
        '\n',
        '\n',
        '\n',
        '\x1b[3A',
    ]);
});

test('ensureSpaceBelow is a no-op for non-positive counts', () => {
    const writes = withMockedStdout(() => {
        ensureSpaceBelow(0);
    });

    assert.deepEqual(writes, []);
});

test('resolveShellLayout keeps footer rows stable and allocates aux panel outside transcript', () => {
    const layout = resolveShellLayout(120, 30, {
        openPanel: 'help',
        preferredWidth: 36,
        side: 'right',
    });

    assert.equal(layout.footerDividerRow, 29);
    assert.equal(layout.footerRow, 30);
    assert.ok(layout.auxPanel);
    assert.equal(layout.transcript.height, 28);
    assert.equal(layout.auxPanel?.height, 28);
    assert.ok((layout.auxPanel?.x || 0) > layout.transcript.x);
});
