import test from 'node:test';
import assert from 'node:assert/strict';
import { fromFetchResult } from '../../src/browser/adaptive-fetch/reader-adapters.js';

function fetched(text: string, contentType = 'text/html') {
    return {
        ok: true,
        status: 200,
        finalUrl: 'https://media.example.test/watch',
        contentType,
        text,
        evidence: ['http-200', contentType],
        warnings: [],
    };
}

test('HTML metadata extracts order-independent OpenGraph, Twitter card, and JSON-LD media', () => {
    const result = fromFetchResult(fetched(`
        <html><head>
          <meta content="https://cdn.example.test/poster.jpg" property="og:image">
          <meta property="og:image:width" content="1280">
          <meta property="og:image:height" content="720">
          <meta content="https://cdn.example.test/video.mp4" property="og:video">
          <meta name="twitter:player" content="/embed/player">
          <meta name="twitter:player:width" content="640">
          <meta name="twitter:player:height" content="360">
          <script type="application/ld+json">
            {"@type":"VideoObject","name":"Clip","contentUrl":"https://cdn.example.test/clip.mp4","thumbnailUrl":"https://cdn.example.test/clip.jpg","duration":"PT2M"}
          </script>
        </head><body><article>Media body</article></body></html>
    `));

    const metadata = result.metadata as Record<string, unknown>;
    const media = metadata['media'] as Record<string, unknown>;
    assert.ok(result.evidence.includes('media-metadata'));
    assert.equal(media['imageUrl'], 'https://cdn.example.test/poster.jpg');
    assert.equal(media['videoUrl'], 'https://cdn.example.test/video.mp4');
    assert.equal(media['imageWidth'], '1280');
    assert.equal(media['imageHeight'], '720');
    assert.deepEqual((media['jsonLdMedia'] as Record<string, unknown>[])[0], {
        type: 'VideoObject',
        name: 'Clip',
        url: 'https://cdn.example.test/clip.mp4',
        thumbnailUrl: 'https://cdn.example.test/clip.jpg',
        duration: 'PT2M',
    });
});

test('oEmbed public endpoint normalizer preserves optional media details', () => {
    const result = fromFetchResult(fetched(JSON.stringify({
        title: 'Video title',
        author_name: 'Creator',
        provider_name: 'Example Video',
        type: 'video',
        url: 'https://media.example.test/watch',
        thumbnail_url: 'https://cdn.example.test/thumb.jpg',
        width: 1280,
        height: 720,
        thumbnail_width: 480,
        thumbnail_height: 270,
        duration_seconds: 123,
        html: '<iframe title="Video title"></iframe>',
    }), 'application/json'), { source: 'public_endpoint', label: 'youtube-oembed' });

    assert.match(result.text, /Thumbnail: https:\/\/cdn\.example\.test\/thumb\.jpg/);
    assert.match(result.text, /Size: 1280x720/);
    assert.match(result.text, /Thumbnail size: 480x270/);
    assert.match(result.text, /Duration: 123/);
    assert.equal(result.metadata?.['thumbnailUrl'], 'https://cdn.example.test/thumb.jpg');
    assert.equal(result.metadata?.['duration'], 123);
});
