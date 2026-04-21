/**
 * Virtual Scroll Regression Tests (tanstack migration)
 *
 * Tests the bootstrap orchestration sequence.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    bootstrapVirtualHistory,
    type VirtualHistoryBootstrapDeps,
} from '../../public/js/virtual-scroll-bootstrap.js';
import {
    remeasureMountedVirtualItems,
    type VirtualItem,
} from '../../public/js/virtual-scroll.js';

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
        setItems: mock.fn((_items: VirtualItem[], opts?: { autoActivate?: boolean; toBottom?: boolean }) => {
            log.push(`setItems(count=${_items.length}, autoActivate=${opts?.autoActivate})`);
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
            'setItems(count=82, autoActivate=false)',
            'activateIfNeeded(toBottom=true)',
            'scrollToBottom',
        ]);
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

    it('handles zero messages', () => {
        const log: string[] = [];
        const items: VirtualItem[] = [];
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        assert.deepStrictEqual(log, [
            'registerCallbacks',
            'setItems(count=0, autoActivate=false)',
            'activateIfNeeded(toBottom=true)',
            'scrollToBottom',
        ]);
    });

    it('setItems uses autoActivate=false', () => {
        const log: string[] = [];
        const items = makeMessageFixture(100);
        const deps = makeDeps(log);
        bootstrapVirtualHistory(items, deps);

        const setEntry = log.find(s => s.startsWith('setItems'));
        assert.ok(setEntry?.includes('autoActivate=false'));
    });

    it('remeasureMountedVirtualItems refreshes cached heights for mounted rows', () => {
        const items = makeMessageFixture(3);
        const measured = [
            { getBoundingClientRect: () => ({ height: 128 }) },
            { getBoundingClientRect: () => ({ height: 212 }) },
        ];
        const mounted = new Map<number, any>([
            [0, measured[0]],
            [2, measured[1]],
        ]);
        const calls: unknown[] = [];
        const virtualizer = {
            measureElement: (el: unknown) => {
                calls.push(el);
            },
        };

        remeasureMountedVirtualItems(items, mounted, virtualizer);

        assert.equal(items[0]?.height, 128);
        assert.equal(items[1]?.height, 80);
        assert.equal(items[2]?.height, 212);
        assert.deepEqual(calls, measured);
    });
});
