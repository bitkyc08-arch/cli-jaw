import '../setup/isolated-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRuntimeSettingsPatch } from '../../src/core/runtime-settings.js';

test('runtime settings rejects dispatch approval TTL above 300 seconds', async () => {
    await assert.rejects(
        applyRuntimeSettingsPatch({ dispatchApproval: { ttlSeconds: 301 } }),
        /invalid_dispatch_approval_ttl/,
    );
});
