import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    dashboard2StaticClosureHasJwcOrCodeChunk,
    type ManifestNode,
} from '../../scripts/check-web-ui-build-output.ts';

const manifestUrl = new URL('../../public/dist/.vite/manifest.json', import.meta.url);

test('localRendererGraphReady: dashboard2 initial graph excludes JWC and Code chunks', () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as Record<string, ManifestNode>;
    const localRendererGraphReady = !dashboard2StaticClosureHasJwcOrCodeChunk(manifest);
    assert.equal(localRendererGraphReady, true);
});

test('localRendererGraphReady rejects a synthetic initial graph containing a JWC chunk', () => {
    const manifest: Record<string, ManifestNode> = {
        'dashboard2/index.html': {
            file: 'assets/dashboard2-entry.js',
            imports: ['src/jwc-runtime.ts'],
        },
        'src/jwc-runtime.ts': { file: 'assets/jwc-runtime.js' },
    };
    const localRendererGraphReady = !dashboard2StaticClosureHasJwcOrCodeChunk(manifest);
    assert.equal(localRendererGraphReady, false);
});
