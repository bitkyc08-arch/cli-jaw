// P04C: launchd plist generator — session keys for TCC/Computer Use
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { generateLaunchdPlist, type PlistOptions } from '../../src/core/launchd-plist.js';

const defaults: PlistOptions = {
    label: 'com.cli-jaw.default',
    port: '3457',
    nodePath: '/usr/local/bin/node',
    jawPath: '/usr/local/bin/jaw',
    jawHome: '/Users/u/.cli-jaw',
    logDir: '/Users/u/.cli-jaw/logs',
    servicePath: '/usr/local/bin:/usr/bin:/bin',
};

test('P04C-001: plist contains ProcessType=Interactive', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/);
});

test('P04C-002: plist sets SessionCreate=true (TCC AppleEvents attribution)', () => {
    // Why flipped: devlog/_plan/computeruse/32_launchd_refinement.md mandates
    // SessionCreate=true so the launchd-spawned process owns its audit session
    // and AppleEvents are attributed to the Jaw.app bundle, not to node.
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>SessionCreate<\/key>\s*<true\/>/);
});

test('P04C-003: plist preserves LimitLoadToSessionType=Aqua (regression)', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
});

test('P04C-004: plist includes --port and --home with correct values', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<string>--port<\/string>/);
    assert.match(plist, /<string>--home<\/string>/);
    assert.match(plist, /<string>3457<\/string>/);
    assert.match(plist, /<string>\/Users\/u\/\.cli-jaw<\/string>/);
});

test('P04C-005: plist escapes XML special characters in jawHome', () => {
    const plist = generateLaunchdPlist({
        ...defaults,
        jawHome: '/tmp/with&ampersand',
    });
    assert.match(plist, /with&amp;ampersand/);
    assert.doesNotMatch(plist, /with&ampersand</);
});

test('P04C-006: plist is valid XML (plutil -lint)', { skip: process.platform !== 'darwin' }, () => {
    const tmp = '/tmp/jaw-test-plist-' + process.pid + '.plist';
    writeFileSync(tmp, generateLaunchdPlist(defaults));
    try {
        execSync(`plutil -lint "${tmp}"`, { stdio: 'pipe' });
    } finally {
        try { unlinkSync(tmp); } catch { /* ok */ }
    }
});

test('P04C-007: plist sets RunAtLoad and KeepAlive', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test('P04C-008: plist sets CLI_JAW_HOME env var', () => {
    const plist = generateLaunchdPlist(defaults);
    assert.match(plist, /<key>CLI_JAW_HOME<\/key>\s*<string>\/Users\/u\/\.cli-jaw<\/string>/);
});
