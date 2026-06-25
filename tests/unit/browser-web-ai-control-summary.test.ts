import test from 'node:test';
import assert from 'node:assert/strict';
import { formatControlSummary, emitControlSummary } from '../../src/browser/web-ai/control-summary.ts';

// 102 control-summary: stderr observability line; never leaks prompt/model/file info.
test('BWAI-CTRLSUM-001: defaults — attached chrome, active tab, new session, visible', () => {
    const out = formatControlSummary();
    assert.equal(out, [
        '[browser] cdp=localhost:9222 (attached to running Chrome on port 9222)',
        '[browser] tab=active (existing active tab)',
        '[browser] session=new',
        '[browser] chrome=visible (may focus window)',
    ].join('\n'));
});

test('BWAI-CTRLSUM-002: pooled tab + recovered session + remote + headless', () => {
    const out = formatControlSummary({
        cdpPort: 9333,
        tabSource: 'pooled',
        sessionReuse: true,
        recoveryUrl: 'https://chatgpt.com/c/abc',
        chromeVisible: false,
        remoteChrome: true,
    });
    assert.match(out, /cdp=localhost:9333 \(remote CDP on port 9333\)/);
    assert.match(out, /tab=pooled \(reusing warm session tab\)/);
    assert.match(out, /session=recovered from https:\/\/chatgpt\.com\/c\/abc/);
    assert.match(out, /chrome=headless/);
});

test('BWAI-CTRLSUM-003: new-tab source label + sessionReuse without recoveryUrl stays new', () => {
    const out = formatControlSummary({ tabSource: 'new-tab', sessionReuse: true });
    assert.match(out, /tab=new \(fresh tab created\)/);
    assert.match(out, /session=new/); // reuse with no recoveryUrl → still "new"
});

test('BWAI-CTRLSUM-004: emit writes to stderr only when controlSummary && !json', () => {
    const original = process.stderr.write.bind(process.stderr);
    const writes: string[] = [];
    (process.stderr as { write: unknown }).write = (chunk: string) => { writes.push(String(chunk)); return true; };
    try {
        emitControlSummary({ cdpPort: 9222 }, { controlSummary: false });
        emitControlSummary({ cdpPort: 9222 }, { controlSummary: true, json: true });
        assert.equal(writes.length, 0, 'no output when disabled or in json mode');
        emitControlSummary({ cdpPort: 9222 }, { controlSummary: true });
        assert.equal(writes.length, 1);
        assert.match(writes[0]!, /\[browser\] cdp=localhost:9222/);
    } finally {
        (process.stderr as { write: unknown }).write = original;
    }
});
