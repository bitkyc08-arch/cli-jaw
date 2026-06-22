import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

function read(path: string): string {
    return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

test('server EADDRINUSE diagnostics are non-destructive and actionable', () => {
    const source = read('server.ts');

    assert.match(source, /port \$\{PORT\} already in use/);
    assert.match(source, /lsof -nP -iTCP:\$\{PORT\} -sTCP:LISTEN/);
    assert.match(source, /no process was killed automatically/);
    assert.doesNotMatch(source, /EADDRINUSE[\s\S]{0,400}killProcessTree/);
});

test('dashboard EADDRINUSE diagnostics are non-destructive and actionable', () => {
    const source = read('src/manager/server.ts');

    assert.match(source, /port \$\{port\} already in use/);
    assert.match(source, /lsof -nP -iTCP:\$\{port\} -sTCP:LISTEN/);
    assert.match(source, /no process was killed automatically/);
    assert.doesNotMatch(source, /EADDRINUSE[\s\S]{0,400}killProcessTree/);
});
