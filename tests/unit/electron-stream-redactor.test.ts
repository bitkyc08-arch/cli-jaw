import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamRedactor } from '../../electron/src/main/lib/stream-redactor.ts';

const TOKEN = 'renderer-token-renderer-token-fixture';

test('electron stream redactor catches every token split across data events', () => {
    for (let split = 0; split <= TOKEN.length; split += 1) {
        let output = '';
        const redactor = createStreamRedactor([TOKEN], (chunk) => {
            output += chunk;
        });

        redactor.write(`before:${TOKEN.slice(0, split)}`);
        redactor.write(`${TOKEN.slice(split)}:after`);
        redactor.end();

        assert.equal(output, 'before:[REDACTED]:after', `split ${split} must be redacted`);
        assert.equal(output.includes(TOKEN), false, `split ${split} must not leak the token`);
    }
});

test('electron stream redactor keeps stdout text intact and flushes a short tail', () => {
    let output = '';
    const redactor = createStreamRedactor([TOKEN], (chunk) => {
        output += chunk;
    });

    redactor.write(Buffer.from('ordinary output'));
    redactor.end();

    assert.equal(output, 'ordinary output');
});
