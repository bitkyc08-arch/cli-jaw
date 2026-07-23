import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseCliFlags } from '../../electron/src/main/lib/cli-flags.ts';

test('explicit root manager URL with spawn remains on the legacy rollback path', () => {
    const previousUrl = process.env.JAW_MANAGER_URL;
    delete process.env.JAW_MANAGER_URL;
    try {
        const rootUrl = 'http://127.0.0.1:24576/';
        const flags = parseCliFlags([`--manager-url=${rootUrl}`, '--spawn'], 24577);
        assert.equal(flags.spawn, true);
        assert.equal(flags.managerUrlExplicit, true);
        assert.equal(flags.managerUrl, rootUrl);
        assert.equal(new URL(flags.managerUrl).pathname, '/');
    } finally {
        if (previousUrl === undefined) delete process.env.JAW_MANAGER_URL;
        else process.env.JAW_MANAGER_URL = previousUrl;
    }
});

test('server wildcard root fallback still serves the legacy manager HTML', () => {
    const source = readFileSync(new URL('../../src/manager/server.ts', import.meta.url), 'utf8');
    // src/manager/server.ts:919 is the rollback contract: '/' reaches this legacy wildcard fallback.
    const fallback = source.match(/app\.get\('\/{\*splat}'[\s\S]*?sendManagerHtml\(res, htmlPath\);\n}\);/);
    assert.ok(fallback, 'legacy wildcard fallback must remain present');
    assert.match(fallback[0], /managerHtmlCandidates/);
    assert.doesNotMatch(fallback[0], /dashboard2HtmlCandidates/);
});
