import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

function read(path: string): string {
    return readFileSync(join(projectRoot, path), 'utf8');
}

test('latest message endpoint returns dashboard summary without full history polling', () => {
    const server = read('server.ts');
    const db = read('src/core/db.ts');
    const hook = read('public/manager/src/hooks/useInstanceMessageEvents.ts');

    assert.ok(server.includes("app.get('/api/messages/latest'"), 'latest endpoint must remain the existing lightweight path');
    assert.ok(server.includes('latestAssistant'), 'latest endpoint must preserve assistant unread baseline');
    assert.ok(server.includes('activity:'), 'latest endpoint must include activity summary');
    assert.ok(server.includes('dashboardActivityTitleFromExcerpt'), 'latest endpoint must clean activity excerpts before returning them');
    assert.ok(db.includes('substr(content, 1, 240) AS excerpt'), 'activity query must only fetch a bounded excerpt');
    assert.equal(server.includes('tool_log'), false, 'latest endpoint must not expose tool logs');
    assert.ok(hook.includes('/i/${port}/api/messages/latest'), 'manager hook must poll the proxied latest endpoint');
    assert.equal(hook.includes('/api/messages`'), false, 'manager hook must not poll full message history');
});

test('manager sidebar wires per-instance labels and latest activity titles', () => {
    const app = read('public/manager/src/App.tsx');
    const list = read('public/manager/src/components/InstanceListContent.tsx');
    const groups = read('public/manager/src/components/InstanceGroups.tsx');
    const row = read('public/manager/src/components/InstanceRow.tsx');
    const hook = read('public/manager/src/hooks/useInstanceLabelEditor.ts');
    const compactCss = read('public/manager/src/manager-p0-1-1.css');

    assert.ok(app.includes('useInstanceLabelEditor'), 'App must keep label persistence outside the main component body');
    assert.ok(app.includes('messageActivity.titlesByPort'), 'App must pass latest activity titles into sidebar rows');
    assert.ok(list.includes('latestTitleByPort'), 'InstanceListContent must accept latest activity title map');
    assert.ok(list.includes('onInstanceLabelSave'), 'InstanceListContent must accept label save callback');
    assert.ok(groups.includes('latestActivityTitle={props.latestTitleByPort?.[instance.port] || null}'), 'InstanceGroups must map titles by instance port');
    assert.ok(groups.includes('onInstanceLabelSave={props.onInstanceLabelSave}'), 'InstanceGroups must forward label save');
    assert.ok(row.includes('props.instance.label || props.profile?.label || props.label'), 'InstanceRow must prefer explicit label over profile/generated label');
    assert.ok(row.includes('instance-label-edit-button'), 'InstanceRow must expose the rename affordance');
    assert.ok(row.includes('instance-label-edit-form'), 'InstanceRow must expose inline edit controls');
    assert.ok(row.includes('instance-row-activity-title'), 'InstanceRow must render the latest activity title line');
    assert.ok(hook.includes("instances: { [String(port)]: { label: nextLabel } }"), 'label editor must persist labels through the registry');
    assert.ok(hook.includes('label?.trim() || null'), 'label editor must clear blank labels back to fallback');
    assert.ok(compactCss.includes('.manager-sidebar .instance-row-activity-title'), 'final compact CSS must not hide latest activity titles');
    assert.ok(compactCss.includes('.manager-sidebar .instance-label-edit-button'), 'final compact CSS must style the rename affordance');
});
