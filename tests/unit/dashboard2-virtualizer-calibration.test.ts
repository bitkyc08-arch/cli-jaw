import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { Virtualizer as ReactVirtualizer } from '@tanstack/react-virtual';
import { Virtualizer as CoreVirtualizer } from '@tanstack/virtual-core';

const require = createRequire(import.meta.url);
const reactVirtualPackage = require('@tanstack/react-virtual/package.json') as { version: string };
const virtualCorePackage = require('@tanstack/virtual-core/package.json') as { version: string };

const ITEM_COUNT = 1_000;
const VIEWPORT_HEIGHT = 600;
const ESTIMATED_HEIGHT = 120;
const HEIGHT_PATTERN = [60, 120, 300] as const;

type CalibrationItem = {
    id: string;
    height: number;
};

function makeItems(prefix: string, count: number): CalibrationItem[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `${prefix}-${index}`,
        height: HEIGHT_PATTERN[index % HEIGHT_PATTERN.length],
    }));
}

function optionsFor(items: CalibrationItem[], overscan: number, initialOffset = 80_000) {
    return {
        count: items.length,
        getScrollElement: () => null,
        estimateSize: () => ESTIMATED_HEIGHT,
        overscan,
        initialRect: { width: 800, height: VIEWPORT_HEIGHT },
        initialOffset,
        getItemKey: (index: number) => items[index]?.id ?? index,
        observeElementRect: () => undefined,
        observeElementOffset: () => undefined,
        scrollToFn: () => undefined,
    };
}

function measureAll(virtualizer: InstanceType<typeof ReactVirtualizer>, items: CalibrationItem[]): void {
    items.forEach((item, index) => virtualizer.resizeItem(index, item.height));
}

const report = {
    adapterVersion: reactVirtualPackage.version,
    coreVersion: virtualCorePackage.version,
    variableHeight: { estimatedTotal: 0, measuredTotal: 0, convergenceDelta: 0 },
    overscan: {} as Record<number, { virtualItems: number; upperBound: number }>,
    prepend: { insertedItems: 200, insertedHeight: 0, anchorOffsetShift: 0 },
    stableKey: { key: '', beforeIndex: 0, afterIndex: 0, remeasuredSize: 0 },
};

test('D12 adapter re-exports the installed virtual-core Virtualizer', () => {
    assert.equal(ReactVirtualizer, CoreVirtualizer);
    assert.equal(reactVirtualPackage.version.split('.')[0], virtualCorePackage.version.split('.')[0]);
});

test('variable-height measurements converge from estimate to the exact total', () => {
    const items = makeItems('item', ITEM_COUNT);
    const virtualizer = new ReactVirtualizer(optionsFor(items, 8, 30_000));
    const estimatedTotal = virtualizer.getTotalSize();
    const expectedTotal = items.reduce((sum, item) => sum + item.height, 0);

    measureAll(virtualizer, items);
    const measuredTotal = virtualizer.getTotalSize();

    assert.equal(estimatedTotal, ITEM_COUNT * ESTIMATED_HEIGHT);
    assert.notEqual(estimatedTotal, expectedTotal, 'fixture must exercise estimate error');
    assert.equal(measuredTotal, expectedTotal);

    report.variableHeight = {
        estimatedTotal,
        measuredTotal,
        convergenceDelta: measuredTotal - estimatedTotal,
    };
});

test('overscan 4/8/12 stays below the variable-height viewport upper bound', () => {
    const items = makeItems('item', ITEM_COUNT);
    const minimumHeight = Math.min(...HEIGHT_PATTERN);

    for (const overscan of [4, 8, 12]) {
        const virtualizer = new ReactVirtualizer(optionsFor(items, overscan));
        measureAll(virtualizer, items);
        const virtualItems = virtualizer.getVirtualItems().length;
        const upperBound = Math.ceil(VIEWPORT_HEIGHT / minimumHeight) + 1 + (2 * overscan);

        assert.ok(virtualItems <= upperBound,
            `overscan ${overscan}: ${virtualItems} virtual items exceeds ${upperBound}`);
        report.overscan[overscan] = { virtualItems, upperBound };
    }
});

test('prepend calibration shifts the anchor by inserted height and preserves stable-key mapping', () => {
    let items = makeItems('old', ITEM_COUNT);
    const virtualizer = new ReactVirtualizer(optionsFor(items, 8));
    measureAll(virtualizer, items);
    virtualizer.getTotalSize();

    const anchorKey = 'old-500';
    const before = virtualizer.measurementsCache[500];
    assert.equal(before?.key, anchorKey);

    const prepended = makeItems('prepended', 200);
    const insertedHeight = prepended.reduce((sum, item) => sum + item.height, 0);
    items = [...prepended, ...items];
    virtualizer.setOptions(optionsFor(items, 8));
    measureAll(virtualizer, prepended);
    virtualizer.getTotalSize();

    const shiftedIndex = 700;
    const shifted = virtualizer.measurementsCache[shiftedIndex];
    assert.equal(shifted?.key, anchorKey);
    assert.equal(shifted.start - before.start, insertedHeight);
    assert.equal(shifted.size, before.size, 'stable key should retain its measured size after reindexing');

    const remeasuredSize = 240;
    virtualizer.resizeItem(shiftedIndex, remeasuredSize);
    virtualizer.getTotalSize();
    const remeasured = virtualizer.measurementsCache[shiftedIndex];
    assert.equal(remeasured.key, anchorKey);
    assert.equal(remeasured.index, shiftedIndex);
    assert.equal(remeasured.size, remeasuredSize);

    report.prepend = {
        insertedItems: prepended.length,
        insertedHeight,
        anchorOffsetShift: shifted.start - before.start,
    };
    report.stableKey = {
        key: anchorKey,
        beforeIndex: before.index,
        afterIndex: remeasured.index,
        remeasuredSize: remeasured.size,
    };
});

test.after(() => {
    console.log(`[D13 calibration report] ${JSON.stringify(report)}`);
});
