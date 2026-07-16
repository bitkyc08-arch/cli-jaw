import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildImplicitManagerUrl,
    resolveManagerRouteUrl,
    resolveManagerUrl,
} from '../../electron/src/main/lib/manager-url.ts';

test('electron manager URL defaults and dynamic ports target dashboard2', () => {
    assert.equal(resolveManagerUrl('', 24577), 'http://127.0.0.1:24577/dashboard2/');
    assert.equal(buildImplicitManagerUrl(24578), 'http://127.0.0.1:24578/dashboard2/');
});

test('electron manager URL preserves an explicit path and query', () => {
    assert.equal(
        resolveManagerUrl('http://127.0.0.1:24576/custom/path?qa=wp1', 24577),
        'http://127.0.0.1:24576/custom/path?qa=wp1',
    );
});

test('electron manager routes stay below the selected manager base path', () => {
    assert.equal(
        resolveManagerRouteUrl('http://127.0.0.1:24577/dashboard2/', '/?sidebar=reminders'),
        'http://127.0.0.1:24577/dashboard2/?sidebar=reminders',
    );
    assert.equal(
        resolveManagerRouteUrl('http://127.0.0.1:24577/dashboard2/', '/projects/demo?tab=files'),
        'http://127.0.0.1:24577/dashboard2/projects/demo?tab=files',
    );
    assert.equal(
        resolveManagerRouteUrl('http://127.0.0.1:24576/', '/projects/demo'),
        'http://127.0.0.1:24576/projects/demo',
    );
});
