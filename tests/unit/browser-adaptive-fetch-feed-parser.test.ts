import test from 'node:test';
import assert from 'node:assert/strict';
import { fromFetchResult } from '../../src/browser/adaptive-fetch/reader-adapters.js';

function fetched(text: string, contentType = 'application/rss+xml') {
    return {
        ok: true,
        status: 200,
        finalUrl: 'https://feeds.example.test/feed',
        contentType,
        text,
        evidence: ['http-200', contentType],
        warnings: [],
    };
}

test('feed parser handles namespaced RSS content, authors, tags, and media', () => {
    const rss = fromFetchResult(fetched(`
        <rss xmlns:content="http://purl.org/rss/1.0/modules/content/"
             xmlns:dc="http://purl.org/dc/elements/1.1/"
             xmlns:media="http://search.yahoo.com/mrss/">
          <channel>
            <title><![CDATA[Release &amp; Notes]]></title>
            <description>Project updates</description>
            <link>https://example.test/releases</link>
            <item>
              <title><![CDATA[First <b>release</b>]]></title>
              <pubDate>Tue, 23 Jun 2026 00:00:00 GMT</pubDate>
              <link>https://example.test/releases/1</link>
              <dc:creator>Alice</dc:creator>
              <category>release</category>
              <category>typescript</category>
              <media:thumbnail url="https://cdn.example.test/thumb.jpg" />
              <content:encoded><![CDATA[<p>Full <strong>release</strong> body &amp; details.</p>]]></content:encoded>
            </item>
          </channel>
        </rss>
    `), { source: 'public_endpoint', label: 'rss-atom-discovered' });

    assert.equal(rss.source, 'public_endpoint');
    assert.equal(rss.metadata?.['endpointKind'], 'rss-atom');
    assert.match(rss.text, /Feed: Release & Notes/);
    assert.match(rss.text, /Item 1: First release/);
    assert.match(rss.text, /Author: Alice/);
    assert.match(rss.text, /Tags: release, typescript/);
    assert.match(rss.text, /Media: https:\/\/cdn\.example\.test\/thumb\.jpg/);
    assert.match(rss.text, /Summary: Full release body & details\./);
    assert.deepEqual(rss.metadata?.['mediaUrls'], ['https://cdn.example.test/thumb.jpg']);
});

test('feed parser handles Atom links and JSON Feed authors/tags/attachments', () => {
    const atom = fromFetchResult(fetched(`
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Atom Feed</title>
          <subtitle>Atom updates</subtitle>
          <link href="https://atom.example.test"/>
          <entry>
            <title>Atom entry</title>
            <updated>2026-06-23T00:00:00Z</updated>
            <link href="https://atom.example.test/e1"/>
            <author><name>Bob</name></author>
            <category term="news">News</category>
            <summary>Atom summary</summary>
          </entry>
        </feed>
    `, 'application/atom+xml'), { source: 'public_endpoint', label: 'rss-atom-discovered' });

    assert.match(atom.text, /Feed: Atom Feed/);
    assert.match(atom.text, /Description: Atom updates/);
    assert.match(atom.text, /URL: https:\/\/atom\.example\.test\/e1/);
    assert.match(atom.text, /Author: Bob/);
    assert.match(atom.text, /Tags: News/);

    const jsonFeed = fromFetchResult(fetched(JSON.stringify({
        title: 'JSON Feed',
        description: 'JSON updates',
        home_page_url: 'https://json.example.test',
        items: [{
            title: 'JSON entry',
            date_modified: '2026-06-23T01:00:00Z',
            external_url: 'https://json.example.test/e1',
            content_html: '<p>JSON <strong>body</strong></p>',
            authors: [{ name: 'Carol' }],
            tags: ['json', 'feed'],
            attachments: [{ url: 'https://cdn.example.test/video.mp4' }],
        }],
    }), 'application/feed+json'), { source: 'public_endpoint', label: 'rss-atom-discovered' });

    assert.equal(jsonFeed.metadata?.['endpointKind'], 'feed-json');
    assert.match(jsonFeed.text, /Feed: JSON Feed/);
    assert.match(jsonFeed.text, /Description: JSON updates/);
    assert.match(jsonFeed.text, /Home: https:\/\/json\.example\.test/);
    assert.match(jsonFeed.text, /Author: Carol/);
    assert.match(jsonFeed.text, /Tags: json, feed/);
    assert.match(jsonFeed.text, /Media: https:\/\/cdn\.example\.test\/video\.mp4/);
    assert.match(jsonFeed.text, /Summary: JSON body/);
});
