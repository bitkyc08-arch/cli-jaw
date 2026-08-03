// Every locale must carry every key. Only ko<->en was gated before, so nine
// channel-status keys shipped ko/en-only and Japanese and Chinese users saw
// Korean text in the transport status row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const load = (locale: string) =>
    JSON.parse(readFileSync(join(repoRoot, `public/locales/${locale}.json`), 'utf8')) as Record<string, string>;

const ko = load('ko');

for (const locale of ['en', 'ja', 'zh']) {
    test(`${locale}.json has every key ko.json has`, () => {
        const target = load(locale);
        const missing = Object.keys(ko).filter(key => !(key in target));
        assert.deepEqual(missing, [], `${locale}.json is missing ${missing.length} keys`);
    });

    test(`${locale}.json has no keys ko.json lacks`, () => {
        const target = load(locale);
        const extra = Object.keys(target).filter(key => !(key in ko));
        assert.deepEqual(extra, [], `${locale}.json has ${extra.length} keys ko.json does not`);
    });

    test(`${locale}.json keeps every {placeholder} its ko counterpart uses`, () => {
        const target = load(locale);
        const holders = (text: string) => new Set(text.match(/\{[a-zA-Z]+\}/g) ?? []);
        for (const [key, koText] of Object.entries(ko)) {
            const value = target[key];
            if (typeof value !== 'string') continue;
            const want = holders(koText);
            if (!want.size) continue;
            // A dropped placeholder renders a literal gap in the UI.
            for (const token of want) {
                assert.ok(value.includes(token), `${locale}.json ${key} lost ${token}`);
            }
        }
    });
}
