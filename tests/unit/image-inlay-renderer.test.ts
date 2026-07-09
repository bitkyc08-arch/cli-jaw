import test from 'node:test';
import assert from 'node:assert/strict';
import { setupWebUiDom, resetWebUiDom } from './web-ui-test-dom.ts';

test.afterEach(() => resetWebUiDom());

test('markdown image renderer preserves uploads/remotes and guards other absolute paths', async () => {
    setupWebUiDom();
    const { renderMarkdown } = await import('../../public/js/render.ts');
    const render = (markdown: string) => {
        const host = document.createElement('div');
        host.innerHTML = renderMarkdown(markdown);
        return host;
    };

    const upload = render('![upload](/Users/me/.cli-jaw/uploads/a.png)').querySelector('img');
    assert.equal(upload?.getAttribute('src'), '/media/a.png');

    const local = render('![local](/workspace/out/a.png)').querySelector('img');
    assert.equal(local?.getAttribute('src'), '/api/image?path=%2Fworkspace%2Fout%2Fa.png');

    const video = render('![clip](/workspace/out/a.mp4)').querySelector('video');
    assert.equal(video?.getAttribute('src'), '/api/image?path=%2Fworkspace%2Fout%2Fa.mp4');

    const remoteUrl = 'https://example.test/a.png?x=1&y=2';
    const remote = render(`![remote](${remoteUrl})`).querySelector('img');
    assert.equal(remote?.getAttribute('src'), remoteUrl);

    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const data = render(`![data](${dataUrl})`).querySelector('img');
    assert.equal(data?.getAttribute('src'), dataUrl);

    const relative = render('![relative](assets/a.png)').querySelector('img');
    assert.equal(relative?.getAttribute('src'), 'assets/a.png');
});
