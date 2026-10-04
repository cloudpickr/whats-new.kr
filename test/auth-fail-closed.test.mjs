import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import worker from '../worker/index.js';

const ALLOWED_IP = '203.0.113.10';
const OTHER_IP = '198.51.100.20';
const SERVICE_TOKEN = 'test-service-token';
const SITE_TOKEN = 'test-site-token';
const MCP_TOKEN = 'test-mcp-token';

const KEY_RING = JSON.stringify([
  { id: 'service-test', type: 'service', token: SERVICE_TOKEN },
  { id: 'site-test', type: 'site', token: SITE_TOKEN },
  { id: 'mcp-test', type: 'mcp', token: MCP_TOKEN },
]);

function createDb({ failMessage } = {}) {
  return {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
        async first() {
          if (failMessage) throw new Error(failMessage);
          return { count: 0, c: 0, total: 0, reviewed: 0 };
        },
        async all() {
          if (failMessage) throw new Error(failMessage);
          return { results: [] };
        },
      };
      return statement;
    },
  };
}

function createEnv(overrides = {}) {
  return {
    SITE_URL: 'https://whats-new.kr',
    API_KEY_RING: KEY_RING,
    AUTH_ENFORCEMENT: 'on',
    SITE_API_ENFORCEMENT: 'on',
    TRUSTED_IP_BYPASS: 'off',
    ALLOWED_ADMIN_IPS: ALLOWED_IP,
    DB: createDb(),
    ...overrides,
  };
}

async function call(env, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await worker.fetch(new Request(new URL(path, 'https://api.whats-new.kr'), {
    method,
    headers,
    body,
  }), env);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { response, text, json };
}

function pipeline(env, headers = {}) {
  return call(env, '/api/pipeline?action=noop', { method: 'POST', headers });
}

describe('worker auth fails closed', { concurrency: 1 }, () => {
  test('trusted IP does not skip Bearer auth on POST /api/pipeline', async () => {
    const result = await pipeline(createEnv({
      AUTH_ENFORCEMENT: 'on',
      TRUSTED_IP_BYPASS: 'on',
    }), {
      'CF-Connecting-IP': ALLOWED_IP,
    });

    assert.equal(result.response.status, 401);
    assert.equal(result.json.error, 'Unauthorized');
    assert.equal(result.text.includes('trusted-ip-bypass'), false);
  });

  test('a valid Bearer token and an allowed IP reach the pipeline handler', async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(' '));
    };
    try {
      const result = await pipeline(createEnv({ TRUSTED_IP_BYPASS: 'on' }), {
        Authorization: `Bearer ${SERVICE_TOKEN}`,
        'CF-Connecting-IP': ALLOWED_IP,
      });
      assert.equal(result.response.status, 400);
      assert.equal(result.json.error, 'invalid action');
      assert.ok(logs.some((line) => line.includes('keyIdFp=') && line.includes('keyType=service')));
      assert.equal(logs.some((line) => line.includes('trusted-ip-bypass')), false);
    } finally {
      console.log = originalLog;
    }
  });

  test('a valid Bearer token from a different IP is forbidden', async () => {
    const result = await pipeline(createEnv(), {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'CF-Connecting-IP': OTHER_IP,
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.json.error, 'Forbidden IP');
  });

  test('an empty admin IP allowlist denies an otherwise valid admin call', async () => {
    for (const allowlist of ['', '   ', ' , ', undefined]) {
      const result = await pipeline(createEnv({ ALLOWED_ADMIN_IPS: allowlist }), {
        Authorization: `Bearer ${SERVICE_TOKEN}`,
        'CF-Connecting-IP': ALLOWED_IP,
      });
      assert.equal(result.response.status, 403, `allowlist ${JSON.stringify(allowlist)}`);
      assert.equal(result.json.error, 'Forbidden IP');
    }
  });

  test('missing or unknown AUTH_ENFORCEMENT fails closed', async () => {
    for (const mode of [undefined, '', 'audit']) {
      const result = await pipeline(createEnv({
        AUTH_ENFORCEMENT: mode,
        TRUSTED_IP_BYPASS: 'on',
      }), {
        'CF-Connecting-IP': ALLOWED_IP,
      });
      assert.equal(result.response.status, 401, `mode ${JSON.stringify(mode)}`);
      assert.equal(result.json.error, 'Unauthorized');
    }
  });

  test('explicit warn and off still follow their named modes', async () => {
    for (const mode of ['warn', 'off']) {
      const warnings = [];
      const logs = [];
      const originalWarn = console.warn;
      const originalLog = console.log;
      console.warn = (...args) => {
        warnings.push(args.join(' '));
      };
      console.log = (...args) => {
        logs.push(args.join(' '));
      };
      try {
        const result = await pipeline(createEnv({
          AUTH_ENFORCEMENT: mode,
          TRUSTED_IP_BYPASS: 'on',
        }), {
          'CF-Connecting-IP': ALLOWED_IP,
        });
        assert.equal(result.response.status, 400, mode);
        assert.equal(result.json.error, 'invalid action');
        const lines = [...warnings, ...logs];
        assert.equal(lines.some((line) => line.includes('trusted-ip-bypass')), false);
        if (mode === 'warn') {
          assert.ok(warnings.some((line) => line.includes('missing_header')));
        }
      } finally {
        console.warn = originalWarn;
        console.log = originalLog;
      }
    }
  });

  test('missing or unknown SITE_API_ENFORCEMENT fails closed', async () => {
    for (const mode of [undefined, '', 'later']) {
      const result = await call(createEnv({ SITE_API_ENFORCEMENT: mode }), '/api/articles');
      assert.equal(result.response.status, 401, `mode ${JSON.stringify(mode)}`);
      assert.match(result.json.error, /POST \/mcp/);
    }
  });

  test('explicit site-api warn allows anonymous reads and a site token still works when on', async () => {
    const warned = await call(createEnv({ SITE_API_ENFORCEMENT: 'warn' }), '/api/articles');
    assert.equal(warned.response.status, 200);
    assert.deepEqual(warned.json.items, []);

    const authed = await call(createEnv({ SITE_API_ENFORCEMENT: 'on' }), '/api/articles', {
      headers: { Authorization: `Bearer ${SITE_TOKEN}` },
    });
    assert.equal(authed.response.status, 200);
    assert.equal(authed.json.count, 0);

    const wrongType = await call(createEnv({ SITE_API_ENFORCEMENT: 'on' }), '/api/articles', {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    assert.equal(wrongType.response.status, 401);
  });

  test('GET /api/stats and MCP get_stats stay public', async () => {
    const stats = await call(createEnv({ AUTH_ENFORCEMENT: 'on' }), '/api/stats');
    assert.equal(stats.response.status, 200);
    assert.equal(stats.json.backlog, 0);
    assert.ok(stats.json.models.translation);

    const mcp = await call(createEnv({ AUTH_ENFORCEMENT: 'on' }), '/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_stats', arguments: {} },
      }),
    });
    assert.equal(mcp.response.status, 200);
    assert.equal(mcp.response.headers.get('X-Auth-Status'), 'anonymous');
    const payload = JSON.parse(mcp.json.result.content[0].text);
    assert.equal(payload.backlog, 0);

    const search = await call(createEnv(), '/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search_releases', arguments: { query: 'public', csp: 'aws' } },
      }),
    });
    assert.equal(search.response.status, 200);
    assert.equal(search.json.result.content[0].text.trim(), '[]');
  });

  test('format=source still requires an mcp token', async () => {
    const denied = await call(createEnv(), '/mcp', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_releases', arguments: { format: 'source', query: 'raw' } },
      }),
    });
    assert.equal(denied.json.error.code, -32001);

    const allowed = await call(createEnv(), '/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'search_releases', arguments: { format: 'source', query: 'raw' } },
      }),
    });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.response.headers.get('X-Auth-Status'), 'authenticated');
    assert.equal(allowed.json.result.content[0].text.trim(), '[]');
  });

  test('search_releases database errors do not return SQL or parameters', async () => {
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => {
      logged.push(args);
    };
    try {
      const result = await call(createEnv({
        DB: createDb({ failMessage: 'secret_marker_db' }),
      }), '/mcp', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'search_releases',
            arguments: { query: 'leak-param-value', csp: 'aws' },
          },
        }),
      });

      assert.equal(result.response.status, 200);
      const text = result.json.result.content[0].text;
      assert.deepEqual(JSON.parse(text), { error: 'Database query failed' });
      assert.equal(result.text.includes('secret_marker_db'), false);
      assert.equal(result.text.includes('leak-param-value'), false);
      assert.equal(result.text.includes('SELECT'), false);
      assert.equal(result.text.includes('"sql"'), false);
      assert.equal(result.text.includes('"params"'), false);

      assert.ok(logged.some((args) => args.some((part) => String(part).includes('secret_marker_db'))));
      assert.ok(logged.some((args) => args.some((part) => part && typeof part === 'object' && String(part.sql).includes('SELECT') && JSON.stringify(part.params).includes('leak-param-value'))));
    } finally {
      console.error = originalError;
    }
  });
});
