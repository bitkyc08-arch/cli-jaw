// An instance list where everything is offline used to render as fifty
// disabled buttons. That is how "no button is clickable" got reported: the
// rows look like controls, sit in the tab order, and refuse every click. They
// are not controls — an offline instance has nothing to open.
//
// Starting one IS a real action, and it already has a real control: the Start
// button beside each row, which routes through use-instance-lifecycle with its
// duplicate-run and error handling. That stays the only start path. Making the
// whole row start the instance was considered and rejected: the row is large,
// its accessible name announces status rather than an action, and a stray
// click or Enter would spawn a local process.
//
// These tests read the source rather than rendering, because the rule being
// pinned is structural: which element type the offline branch emits, and that
// nothing but the CTA reaches the lifecycle runner.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const SIDEBAR = resolve(import.meta.dirname, '..', '..', 'public/dashboard2/src/shell/Sidebar.tsx');
const source = readFileSync(SIDEBAR, 'utf8');

/** The JSX for the instance row's main element, both branches. */
function instanceMainBranches(): { online: string; offline: string } {
    const start = source.indexOf('{isOnline ? (');
    assert.notEqual(start, -1, 'the instance row should branch on isOnline');
    const end = source.indexOf('<div className="d2-instance-trail"', start);
    assert.notEqual(end, -1, 'the trail follows the main element');
    const block = source.slice(start, end);
    const split = block.indexOf(') : (');
    assert.notEqual(split, -1, 'the branch should have both arms');
    return { online: block.slice(0, split), offline: block.slice(split) };
}

test('an offline row is not a control', () => {
    const { offline } = instanceMainBranches();
    assert.match(offline, /<div className="d2-instance-main is-offline">/,
        'the offline arm should render a status element, not a button');
    assert.doesNotMatch(offline, /<button/,
        'the offline arm must not contain a button of its own');
    assert.doesNotMatch(offline, /onClick/,
        'the offline arm must not carry a click handler');
});

test('the online row is still the control it always was', () => {
    const { online } = instanceMainBranches();
    assert.match(online, /<button/, 'the online arm should still be a button');
    assert.match(online, /onClick=\{\(\) => handleInstanceClick\(instance\)\}/);
    assert.match(online, /aria-expanded=\{isExpanded\}/);
});

test('no disabled instance-main button survives anywhere', () => {
    // The specific shape that caused the report: a row rendered as a button
    // that is disabled because the instance is offline.
    assert.doesNotMatch(source, /className="d2-instance-main"[\s\S]{0,200}?disabled=\{!isOnline\}/,
        'the row must not be a button disabled on offline');
});

test('the Start CTA is the only lifecycle path on the row itself', () => {
    // The row's More Actions menu keeps its restart/perm/stop items — those are
    // deliberate, explicitly-labelled menu choices, not a large surface that
    // starts a process when brushed. What must not exist is a lifecycle call
    // reachable from the row element.
    const { online, offline } = instanceMainBranches();
    for (const [name, arm] of Object.entries({ online, offline })) {
        assert.doesNotMatch(arm, /runLifecycleAction/,
            `the ${name} row element must not run a lifecycle action`);
    }

    // Every lifecycle call site must be a control or a menu item, never the row.
    for (const match of source.matchAll(/runLifecycleAction\(/g)) {
        const context = source.slice(Math.max(0, match.index - 700), match.index);
        const onControl = /className=\{`d2-instance-control/.test(context);
        const onMenuItem = /role="menuitem"/.test(context.slice(-400));
        assert.ok(onControl || onMenuItem,
            `a lifecycle call is not on a control or menu item:\n...${context.slice(-160)}`);
    }
});

test('the Start CTA stays visible without hover on an offline row', () => {
    // The row no longer looks clickable, so the CTA is the only affordance
    // left. It must not be hidden behind hover.
    assert.match(source, /d2-instance-control is-\$\{isOnline \? 'stop' : 'start'\} is-always-visible/);
});
