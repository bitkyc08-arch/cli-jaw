// Phase 7 — Network page pure helpers + dirty-store wiring.
//
// Tests cover:
//   • parsePublicOriginHint URL validation (empty/valid/invalid)
//   • detectSelfLockoutRisk for loopback + remote origins
//   • isRemoteAccessMode type guard
//   • dirty store + expandPatch produce the nested PUT body the plan specifies
//   • mode=off saves drop the conditional sub-fields by not emitting them
//   • bindHost + lanBypass dirty entries route to the correct dotted keys

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirtyStore } from '../../public/manager/src/settings/dirty-store';
import { expandPatch } from '../../public/manager/src/settings/pages/path-utils';
import {
    detectSelfLockoutRisk,
    isRemoteAccessMode,
    parsePublicOriginHint,
    REMOTE_ACCESS_MODES,
} from '../../public/manager/src/settings/pages/Network';

// ─── parsePublicOriginHint ───────────────────────────────────────────

test('parsePublicOriginHint: empty input → empty', () => {
    assert.deepEqual(parsePublicOriginHint(''), { kind: 'empty' });
    assert.deepEqual(parsePublicOriginHint('   '), { kind: 'empty' });
});

test('parsePublicOriginHint: https URL → valid origin', () => {
    const r = parsePublicOriginHint('https://tunnel.example.com');
    assert.equal(r.kind, 'valid');
    assert.equal(r.kind === 'valid' ? r.origin : null, 'https://tunnel.example.com');
});

test('parsePublicOriginHint: strips port preservation', () => {
    const r = parsePublicOriginHint('http://10.0.0.1:8080/');
    assert.equal(r.kind, 'valid');
    assert.equal(r.kind === 'valid' ? r.origin : null, 'http://10.0.0.1:8080');
});

test('parsePublicOriginHint: rejects non-http(s) protocols', () => {
    const r = parsePublicOriginHint('ws://example.com');
    assert.equal(r.kind, 'invalid');
});

test('parsePublicOriginHint: rejects URLs with paths/queries/hashes', () => {
    assert.equal(parsePublicOriginHint('https://x.com/api').kind, 'invalid');
    assert.equal(parsePublicOriginHint('https://x.com?q=1').kind, 'invalid');
    assert.equal(parsePublicOriginHint('https://x.com#frag').kind, 'invalid');
});

test('parsePublicOriginHint: rejects garbage strings', () => {
    assert.equal(parsePublicOriginHint('not-a-url').kind, 'invalid');
    assert.equal(parsePublicOriginHint('https://').kind, 'invalid');
});

// ─── detectSelfLockoutRisk ───────────────────────────────────────────

test('detectSelfLockoutRisk: loopback origin never locks out', () => {
    assert.equal(
        detectSelfLockoutRisk({
            currentMode: 'full',
            nextMode: 'off',
            locationHost: 'localhost:8000',
        }),
        false,
    );
    assert.equal(
        detectSelfLockoutRisk({
            currentMode: 'full',
            nextMode: 'off',
            locationHost: '127.0.0.1:8000',
        }),
        false,
    );
});

test('detectSelfLockoutRisk: remote origin + flipping to off → risk', () => {
    assert.equal(
        detectSelfLockoutRisk({
            currentMode: 'full',
            nextMode: 'off',
            locationHost: 'tunnel.example.com',
        }),
        true,
    );
});

test('detectSelfLockoutRisk: remote origin but mode unchanged → no risk', () => {
    assert.equal(
        detectSelfLockoutRisk({
            currentMode: 'off',
            nextMode: 'off',
            locationHost: 'tunnel.example.com',
        }),
        false,
    );
});

test('detectSelfLockoutRisk: remote origin going off→full → no risk', () => {
    assert.equal(
        detectSelfLockoutRisk({
            currentMode: 'off',
            nextMode: 'full',
            locationHost: 'tunnel.example.com',
        }),
        false,
    );
});

// ─── isRemoteAccessMode + REMOTE_ACCESS_MODES ────────────────────────

test('REMOTE_ACCESS_MODES is the canonical 3-tuple', () => {
    assert.deepEqual([...REMOTE_ACCESS_MODES], ['off', 'http-only', 'full']);
});

test('isRemoteAccessMode type-guards string union', () => {
    assert.equal(isRemoteAccessMode('off'), true);
    assert.equal(isRemoteAccessMode('http-only'), true);
    assert.equal(isRemoteAccessMode('full'), true);
    assert.equal(isRemoteAccessMode('partial'), false);
    assert.equal(isRemoteAccessMode(undefined), false);
    assert.equal(isRemoteAccessMode(null), false);
});

// ─── dirty-store + expandPatch shape ─────────────────────────────────

test('Network bundle expands to deep network.* patch', () => {
    const store = createDirtyStore();
    store.set('network.bindHost', { value: '0.0.0.0', original: '127.0.0.1', valid: true });
    store.set('network.lanBypass', { value: true, original: false, valid: true });
    store.set('network.remoteAccess.mode', { value: 'full', original: 'off', valid: true });
    store.set('network.remoteAccess.trustProxies', { value: true, original: false, valid: true });
    store.set('network.remoteAccess.publicOriginHint', {
        value: 'https://tunnel.example.com',
        original: '',
        valid: true,
    });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, {
        network: {
            bindHost: '0.0.0.0',
            lanBypass: true,
            remoteAccess: {
                mode: 'full',
                trustProxies: true,
                publicOriginHint: 'https://tunnel.example.com',
            },
        },
    });
});

test('mode=off bundle does not carry sub-field edits if none were made', () => {
    const store = createDirtyStore();
    store.set('network.remoteAccess.mode', { value: 'off', original: 'full', valid: true });
    const patch = expandPatch(store.saveBundle());
    assert.deepEqual(patch, { network: { remoteAccess: { mode: 'off' } } });
});

test('Invalid publicOriginHint is dropped from saveBundle', () => {
    const store = createDirtyStore();
    store.set('network.remoteAccess.mode', { value: 'full', original: 'off', valid: true });
    store.set('network.remoteAccess.publicOriginHint', {
        value: 'ws://bad',
        original: '',
        valid: false,
    });
    const bundle = store.saveBundle();
    assert.deepEqual(Object.keys(bundle).sort(), ['network.remoteAccess.mode']);
});

test('Reverting bindHost to original clears its dirty entry', () => {
    const store = createDirtyStore();
    store.set('network.bindHost', { value: '0.0.0.0', original: '127.0.0.1', valid: true });
    assert.equal(store.isDirty(), true);
    store.set('network.bindHost', { value: '127.0.0.1', original: '127.0.0.1', valid: true });
    assert.equal(store.isDirty(), false);
});
