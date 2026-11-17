// The administration routes over real HTTP, behind the REAL authGuard.apikey: only the global apikey gets in.
require('express-async-errors');
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { loadTs } = require('./helpers/ts-loader.cjs');
const { linkModule } = require('./helpers/link-harness.cjs');

const GLOBAL_KEY = 'GLOBAL-KEY-FOR-TESTS';
const INSTANCE_KEY = 'INSTANCE-OWN-TOKEN';

class Thrown {
  constructor(status, error, message) {
    throw { status, error, message };
  }
}
const lookups = [];
const authGuard = loadTs('src/api/guards/auth.guard.ts', {
  '@api/server.module': {
    prismaRepository: {
      instance: {
        findUnique: async ({ where }) => {
          lookups.push(where);
          return { name: where.name, token: INSTANCE_KEY };
        },
        findFirst: async () => null,
      },
    },
  },
  '@config/env.config': {
    configService: { get: (key) => (key === 'AUTHENTICATION' ? { API_KEY: { KEY: GLOBAL_KEY } } : { SAVE_DATA: { INSTANCE: true } }) },
  },
  '@config/logger.config': { Logger: class { error() {} } },
  '@exceptions': {
    UnauthorizedException: class extends Thrown {
      constructor() {
        super(401, 'Unauthorized', 'Unauthorized');
      }
    },
    ForbiddenException: class extends Thrown {
      constructor() {
        super(403, 'Forbidden', 'Forbidden');
      }
    },
  },
}).authGuard;

const calls = [];
const fakeService = {
  createLink: async (input) => {
    calls.push(['create', input]);
    if (input.instanceName === 'missing') throw new linkModule.LinkError('not_found', 'The "missing" instance does not exist');
    if (input.instanceName === 'boom') throw new Error('unexpected failure with secret details');
    return { id: 'link-1', token: 'T'.repeat(43), path: `/manager/link#t=${'T'.repeat(43)}` };
  },
  listLinks: async (instanceName) => {
    calls.push(['list', instanceName]);
    if (!instanceName) throw new linkModule.LinkError('bad_request', 'instanceName is required');
    return [{ id: 'link-1', state: 'active' }];
  },
  revokeLink: async (linkId) => {
    calls.push(['revoke', linkId]);
    if (linkId === 'nope') throw new linkModule.LinkError('not_found', 'Link not found');
    return { id: linkId, state: 'revoked' };
  },
  describeSessionStore: () => 'database',
};

const LINK_CONFIG = { TRUST_PROXY_HOPS: 1, PUBLIC_ENABLED: false, PUBLIC_BASE_URL: null };
const { LinkTokenRouter } = loadTs('src/api/routes/linkToken.router.ts', {
  '@api/services/link.service': { LinkError: linkModule.LinkError },
  '@config/env.config': { configService: { get: () => LINK_CONFIG } },
  '@utils/clientIp': loadTs('src/utils/clientIp.ts'),
  '@validate/link.schema': loadTs('src/validate/link.schema.ts'),
});

function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/instance/linkTokens', new LinkTokenRouter(fakeService, authGuard.apikey).router);
  // Same shape as the global handler in main.ts.
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ status: error.status || 500, error: error.error || 'Internal Server Error' });
  });
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function call(server, method, path, { key, body, headers } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { ...(key ? { apikey: key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

const ROUTES = [
  ['POST', '/instance/linkTokens', { instanceName: 'a' }],
  ['GET', '/instance/linkTokens?instanceName=a'],
  ['GET', '/instance/linkTokens/_diagnostics'],
  ['DELETE', '/instance/linkTokens/link-1'],
];

test('only the global apikey is accepted; an instance apikey, a wrong key or none is not', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  for (const [method, path, body] of ROUTES) {
    for (const [label, key] of [['no key', undefined], ['wrong key', 'nope'], ['instance apikey', INSTANCE_KEY]]) {
      const response = await call(server, method, path, { key, body });
      assert.equal(response.status, 401, `${method} ${path} with ${label}`);
    }
  }
  assert.deepEqual(calls, [], 'nothing reached the service');
  assert.deepEqual(lookups, [], 'an instance key is never even looked up: there is no :instanceName to match it against');

  for (const [method, path, body] of ROUTES) {
    const response = await call(server, method, path, { key: GLOBAL_KEY, body });
    assert.ok([200, 201].includes(response.status), `${method} ${path} with the global key -> ${response.status}`);
  }
});

test('an instanceName in the query or body cannot be used to borrow an instance key', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const viaQuery = await call(server, 'GET', '/instance/linkTokens?instanceName=a', { key: INSTANCE_KEY });
  const viaBody = await call(server, 'POST', '/instance/linkTokens?instanceName=a', { key: INSTANCE_KEY, body: { instanceName: 'a' } });
  assert.equal(viaQuery.status, 401);
  assert.equal(viaBody.status, 401);
});

test('create: validates strictly, answers 201 with no-store, and maps errors without leaking details', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  calls.length = 0;

  const ok = await call(server, 'POST', '/instance/linkTokens', {
    key: GLOBAL_KEY,
    body: { instanceName: 'a', ttlHours: 2, displayName: 'Tienda', allowReset: true, expectedNumber: '+52 462 123 4567' },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(ok.body.path, /^\/manager\/link#t=/);
  assert.equal(calls.length, 1);

  const before = calls.length;
  for (const body of [
    {},
    { instanceName: '' },
    { instanceName: 'a', allowreset: true }, // a typo must not silently create a link without the permission
    { instanceName: 'a', extra: 1 },
    { instanceName: 'a', ttlHours: 169 },
    { instanceName: 'a', ttlHours: 0 },
    { instanceName: 'a', ttlHours: '24' },
    { instanceName: 'a', allowReset: 'true' },
    { instanceName: 'a', displayName: 'x'.repeat(101) },
    { instanceName: 'a', expectedNumber: 5 },
    { instanceName: 5 },
  ]) {
    const response = await call(server, 'POST', '/instance/linkTokens', { key: GLOBAL_KEY, body: body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error, 'bad_request');
  }
  assert.equal(calls.length, before, 'invalid requests never reach the service');

  const missing = await call(server, 'POST', '/instance/linkTokens', { key: GLOBAL_KEY, body: { instanceName: 'missing' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');

  const boom = await call(server, 'POST', '/instance/linkTokens', { key: GLOBAL_KEY, body: { instanceName: 'boom' } });
  assert.equal(boom.status, 500);
  assert.ok(!JSON.stringify(boom.body).includes('secret'));
});

test('list, revoke and diagnostics', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  calls.length = 0;

  const list = await call(server, 'GET', '/instance/linkTokens?instanceName=a', { key: GLOBAL_KEY });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, { links: [{ id: 'link-1', state: 'active' }] });
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal((await call(server, 'GET', '/instance/linkTokens', { key: GLOBAL_KEY })).status, 400);

  const revoked = await call(server, 'DELETE', '/instance/linkTokens/link-1', { key: GLOBAL_KEY });
  assert.deepEqual(revoked.body, { id: 'link-1', state: 'revoked' });
  assert.equal((await call(server, 'DELETE', '/instance/linkTokens/nope', { key: GLOBAL_KEY })).status, 404);

  const spoofed = await call(server, 'GET', '/instance/linkTokens/_diagnostics', {
    key: GLOBAL_KEY,
    headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
  });
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.body.hops, 1);
  assert.deepEqual(spoofed.body.resolved, { ip: '203.0.113.9', source: 'forwarded' });
  assert.equal(spoofed.body.xForwardedFor, '6.6.6.6, 203.0.113.9');
  assert.equal(spoofed.body.sessionStore, 'database');
  assert.equal(spoofed.body.publicEnabled, false);
  assert.ok(!JSON.stringify(spoofed.body).includes(GLOBAL_KEY));

  const direct = await call(server, 'GET', '/instance/linkTokens/_diagnostics', { key: GLOBAL_KEY });
  assert.equal(direct.body.resolved.source, 'socket');
});
