import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHelpOverlay, renderCommandPalette } from '../../src/cli/tui/overlay.ts';

test('renderHelpOverlay returns positive box height', () => {
    let output = '';
    const height = renderHelpOverlay(
        (chunk) => { output += chunk; },
        80, 24, '\x1b[2m', '\x1b[0m',
    );
    assert.ok(height > 0, 'should return box height');
    assert.ok(output.includes('Help'), 'should contain Help title');
    assert.ok(output.includes('Escape'), 'should contain dismiss hint');
});

test('renderHelpOverlay with extra commands', () => {
    let output = '';
    renderHelpOverlay(
        (chunk) => { output += chunk; },
        80, 24, '\x1b[2m', '\x1b[0m',
        [{ name: 'quit', desc: 'exit' }, { name: 'model', desc: 'switch model' }],
    );
    assert.ok(output.includes('/quit'), 'should contain /quit');
    assert.ok(output.includes('/model'), 'should contain /model');
});

test('renderCommandPalette renders items with selection highlight', () => {
    let output = '';
    const height = renderCommandPalette({
        write: (chunk) => { output += chunk; },
        cols: 80,
        rows: 24,
        dimCode: '\x1b[2m',
        resetCode: '\x1b[0m',
        filter: '',
        items: [
            { name: 'help', desc: 'show help' },
            { name: 'quit', desc: 'exit chat' },
            { name: 'model', desc: 'switch model' },
        ],
        selected: 1,
    });
    assert.ok(height > 0, 'should return box height');
    assert.ok(output.includes('Commands'), 'should contain Commands title');
    assert.ok(output.includes('\x1b[7m'), 'should contain reverse video for selected');
});

test('renderCommandPalette handles empty items', () => {
    let output = '';
    const height = renderCommandPalette({
        write: (chunk) => { output += chunk; },
        cols: 80,
        rows: 24,
        dimCode: '\x1b[2m',
        resetCode: '\x1b[0m',
        filter: 'nonexistent',
        items: [],
        selected: 0,
    });
    assert.ok(height > 0, 'should still render box frame');
    assert.ok(output.includes('Commands'), 'should still show title');
});

test('renderCommandPalette respects small terminal', () => {
    let output = '';
    const height = renderCommandPalette({
        write: (chunk) => { output += chunk; },
        cols: 40,
        rows: 12,
        dimCode: '\x1b[2m',
        resetCode: '\x1b[0m',
        filter: '',
        items: Array.from({ length: 20 }, (_, i) => ({ name: `cmd${i}`, desc: `desc ${i}` })),
        selected: 0,
    });
    assert.ok(height <= 12, 'box should not exceed terminal rows');
});
