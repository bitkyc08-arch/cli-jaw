/**
 * Virtual Scroll Regression Tests (fix-13)
 *
 * Tests the pure-logic bootstrap orchestration without DOM dependencies.
 * Validates issue #101 root causes are addressed by the bootstrap sequence.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    bootstrapVirtualHistory,
    BOOTSTRAP_SEED_COUNT,
    type VirtualHistoryBootstrapDeps,
} from '../../public/js/virtual-scroll-bootstrap.js';
import type { VirtualItem } from '../../public/js/virtual-scroll.js';

function makeMessageFixture(count: number): VirtualItem[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `msg-${i}`,
        html: `<div class="msg msg-agent"><div class="msg-content">Message ${i}</div></div>`,
        height: 80,
    }));
}

function makeDeps(log: string[]): VirtualHistoryBootstrapDeps {
    return {
        registerCallbacks: mock.fn(() => { log.push('registerCallbacks'); }),
        measureTailWindow: mock.fn((_items: VirtualItem[], seedCount: number) => {
            log.push(`measureTailWindow(seedCount=${seedCount})`);
            return Array.from({ length: Math.min(seedCount, _items.length) }, () => 120);
        }),
        setItems: mock.fn((_items: VirtualItem[], opts?: { autoActivate?: boolean; toBottom?: boolean }) => {
            log.push(`setItems(count=${_items.length}, autoActivate=${opts?.autoActivate})`);
        }),
        seedMeasuredHeights: mock.fn((start: number, h: number[]) => {
            log.push(`seedMeasuredHeights(start=${start}, count=${h.length})`);
        }),
        activateIfNeeded: mock.fn((toBottom: boolean) => {
            log.push(`activateIfNeeded(toBottom=${toBottom})`);
        }),
        scrollToBottom: mock.fn(() => { log.push('scrollToBottom'); }),
    };
}

describe('bootstrapVirtualHistory', () => {
    it('executes operations in correct order for 82 messages', () => {
        const log: string[] = [];
        const items = makeMessageFixture(82);
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        assert.deepStrictEqual(log, [
            'registerCallbacks',
            `setItems(count=82, autoActivate=false)`,
            `measureTailWindow(seedCount=${BOOTSTRAP_SEED_COUNT})`,
            `seedMeasuredHeights(start=${82 - BOOTSTRAP_SEED_COUNT}, count=${BOOTSTRAP_SEED_COUNT})`,
            'activateIfNeeded(toBottom=true)',
            'scrollToBottom',
        ]);
    });

    it('seedMeasuredHeights is called before activateIfNeeded', () => {
        const log: string[] = [];
        const items = makeMessageFixture(100);
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        const seedIdx = log.findIndex(s => s.startsWith('seedMeasuredHeights'));
        const activateIdx = log.findIndex(s => s.startsWith('activateIfNeeded'));
        assert.ok(seedIdx < activateIdx, 'seedMeasuredHeights must precede activateIfNeeded');
    });

    it('registerCallbacks is called before setItems', () => {
        const log: string[] = [];
        const items = makeMessageFixture(90);
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        const cbIdx = log.findIndex(s => s === 'registerCallbacks');
        const setIdx = log.findIndex(s => s.startsWith('setItems'));
        assert.ok(cbIdx < setIdx, 'registerCallbacks must precede setItems');
    });

    it('handles small message count (< 80) — still seeds what it can', () => {
        const log: string[] = [];
        const items = makeMessageFixture(30);
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        assert.deepStrictEqual(log, [
            'registerCallbacks',
            `setItems(count=30, autoActivate=false)`,
            `measureTailWindow(seedCount=${BOOTSTRAP_SEED_COUNT})`,
            `seedMeasuredHeights(start=${Math.max(0, 30 - BOOTSTRAP_SEED_COUNT)}, count=${BOOTSTRAP_SEED_COUNT})`,
            'activateIfNeeded(toBottom=true)',
            'scrollToBottom',
        ]);
    });

    it('handles zero messages', () => {
        const log: string[] = [];
        const items: VirtualItem[] = [];
        const deps = makeDeps(log);

        // measureTailWindow returns [] for 0 items
        deps.measureTailWindow = mock.fn(() => {
            log.push(`measureTailWindow(seedCount=${BOOTSTRAP_SEED_COUNT})`);
            return [];
        });

        bootstrapVirtualHistory(items, deps);

        assert.deepStrictEqual(log, [
            'registerCallbacks',
            `setItems(count=0, autoActivate=false)`,
            `measureTailWindow(seedCount=${BOOTSTRAP_SEED_COUNT})`,
            // seedMeasuredHeights NOT called — empty heights array
            'activateIfNeeded(toBottom=true)',
            'scrollToBottom',
        ]);
    });

    it('setItems uses autoActivate=false to prevent premature activation', () => {
        const log: string[] = [];
        const items = makeMessageFixture(100);
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        const setEntry = log.find(s => s.startsWith('setItems'));
        assert.ok(setEntry?.includes('autoActivate=false'), 'setItems must use autoActivate=false');
    });

    it('seed starts at correct index for tail window', () => {
        const log: string[] = [];
        const items = makeMessageFixture(200);
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        const expected = 200 - BOOTSTRAP_SEED_COUNT;
        const seedEntry = log.find(s => s.startsWith('seedMeasuredHeights'));
        assert.ok(seedEntry?.includes(`start=${expected}`), `seed should start at ${expected}`);
    });
});
