import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import worker, { parseRSS } from '../worker/index.js';

const MCP_TOKEN = 'test-mcp-token';

function rssItem(description) {
  return `
    <rss><channel><item>
      <title>Long release note</title>
      <link>https://example.com/release</link>
      <pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate>
      <description><![CDATA[${description}]]></description>
    </item></channel></rss>`;
}

function atomEntry(content) {
  return `
    <feed><entry>
      <title>GCP release notes</title>
      <link href="https://example.com/gcp-release" />
      <updated>2026-10-01T00:00:00Z</updated>
      <content><![CDATA[${content}]]></content>
    </entry></feed>`;
}

describe('source description retention', () => {
  test('RSS ingestion retains descriptions longer than the former 2,000-character cap', () => {
    const source = 'A'.repeat(2_500);
    const [item] = parseRSS(rssItem(source), 'aws');

    assert.equal(item.description.length, source.length);
    assert.equal(item.description, source);
  });

  test('GCP section ingestion retains bodies longer than the former 1,500-character cap', () => {
    const source = 'B'.repeat(2_500);
    const [item] = parseRSS(atomEntry(
      `<h2 class="release-note-product-title">Cloud Product</h2><p>${source}</p>`,
    ), 'gcp');

    assert.equal(item.title, 'Cloud Product');
    assert.equal(item.description.length, source.length);
    assert.equal(item.description, source);
  });

  test('MCP get_release format=source returns the stored description without truncation', async () => {
    const source = 'C'.repeat(3_000);
    const db = {
      prepare(sql) {
        const statement = {
          bind() { return statement; },
          async run() { return { meta: { changes: 0 } }; },
          async first() {
            if (sql.includes('FROM articles WHERE id = ?')) {
              return {
                article_id: 42,
                csp: 'aws',
                title: 'Long release note',
                description: source,
                url: 'https://example.com/release',
                pub_date: '2026-10-01T00:00:00.000Z',
              };
            }
            return null;
          },
        };
        return statement;
      },
    };
    const response = await worker.fetch(new Request('https://api.whats-new.kr/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_release', arguments: { id: 42, format: 'source' } },
      }),
    }), {
      API_KEY_RING: JSON.stringify([{ id: 'mcp-test', type: 'mcp', token: MCP_TOKEN }]),
      DB: db,
    });

    const rpc = await response.json();
    const release = JSON.parse(rpc.result.content[0].text);
    assert.equal(release.description.length, source.length);
    assert.equal(release.description, source);
  });
});
