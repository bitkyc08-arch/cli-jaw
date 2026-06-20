import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTranscriptItem } from '../../bin/commands/tui/fullscreen-mode.ts';
import { visualWidth } from '../../src/cli/tui/renderers.ts';

function stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, '');
}

test('fullscreen user transcript wraps long screenshot paths into physical rows', () => {
    const longPath = '/var/folders/l5/54gwcgf94ld_kt2gyry3q6p00000gn/T/TemporaryItems/NSIRD_screencaptureui_qrCmSO/Screenshot 2026-06-14 at 9.07.33 PM.png';
    const rows = renderTranscriptItem({
        type: 'user',
        displayText: `확인해줘 ${longPath}`,
        submitText: `확인해줘 ${longPath}`,
        timestamp: 0,
    }, 54);
    const plainRows = rows.map(stripAnsi);

    assert.equal(rows.some(row => row.includes('\n')), false);
    assert.ok(rows.length > 2, 'long path should wrap to continuation rows');
    assert.match(plainRows[0] ?? '', /╭─ You/);
    assert.match(plainRows[1] ?? '', /│/);
    assert.ok(rows.every(row => visualWidth(row) <= 54), 'wrapped rows must fit the frame width');
    assert.match(plainRows.join('\n'), /NSIRD_screencaptureui/);
});
