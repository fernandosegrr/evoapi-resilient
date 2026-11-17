// The public router over real HTTP: headers, no CORS, a 2 KB JSON-only body, generic and uniform errors, per-IP limits,
// inert GETs, and what it will and will not log.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { loadTs } = require('./helpers/ts-loader.cjs');
const { linkModule } = require('./helpers/link-harness.cjs');

const tok = (character) => character.repeat(43);
const VALID = tok('v');
const REVOKED = tok('r');
const LIMITED = tok('l');
const BROKEN = tok('b');
const BUSY = tok('u');

const logs = [];
class SpyLogger {
  info(entry) {
    logs.push(['info', entry]);
  }
  warn(entry) {
    logs.push(['warn', entry]);
  }
  error(entry) {
    logs.push(['error', entry]);
  }
  log(entry) {
    logs.push(['log', entry]);
  }
}
const { createPublicLinkRouter } = loadTs('src/api/routes/publicLink.router.ts', {
  '@api/services/link.service': { LinkError: linkModule.LinkError },
  '@config/logger.config': { Logger: SpyLogger },
  '@utils/clientIp': loadTs('src/utils/clientIp.ts'),
  '@utils/linkToken': loadTs('src/utils/linkToken.ts'),
  '@utils/rateLimiter': loadTs('src/utils/rateLimiter.ts'),
});

const calls = [];
// invalid_link carries the real wording: the router answers a missing token itself and both must be byte-identical.
const linkError = (code, retryAfterMs) =>
  new linkModule.LinkError(code, code === 'invalid_link' ? 'Enlace inválido o vencido.' : `message for ${code}`, retryAfterMs);
const respond = (name, token, extra) => {
  calls.push([name, token, extra]);
  if (token === REVOKED || token === tok('x')) throw linkError('invalid_link');
  if (token === LIMITED) throw linkError('rate_limited', 90_000);
  if (token === BUSY) throw linkError('has_session');
  if (token === BROKEN) throw new Error('database password is hunter2');
  return { ok: name };
};
const fakeService = {
  status: async (token) => respond('status', token),
  code: async (token) => respond('code', token),
  start: async (token, body) => ({ ...respond('start', token, body), mode: body.mode }),
};

const clock = { now: Date.parse('2026-10-06T12:00:00Z') };
const globalMiddlewareLeaks = [];

async function startServer({ hops = 1, enabled = true } = {}) {
  const app = express();
  // Whatever the rest of the app does must never see requests of the public router.
  app.use('/public/link', createPublicLinkRouter({ linkService: fakeService, config: { TRUST_PROXY_HOPS: hops }, now: () => clock.now }));
  app.use((req, res) => {
    globalMiddlewareLeaks.push(req.originalUrl);
    res.status(404).json({ error: 'global-404' });
  });
  app.use((error, _req, res, _next) => {
    globalMiddlewareLeaks.push(`error:${error?.message}`);
    res.status(500).json({ error: 'global-error', message: error?.message });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function call(server, method, path, { token, body, raw, headers } = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/public/link${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

const reset = () => {
  calls.length = 0;
  logs.length = 0;
  globalMiddlewareLeaks.length = 0;
  clock.now = Date.parse('2026-10-06T12:00:00Z');
};

const SECURITY = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};
const assertSecure = (response, label) => {
  for (const [name, value] of Object.entries(SECURITY)) assert.equal(response.headers.get(name), value, `${label}: ${name}`);
  assert.equal(response.headers.get('x-powered-by'), null, `${label}: x-powered-by`);
  for (const name of response.headers.keys()) assert.ok(!name.startsWith('access-control-'), `${label}: ${name}`);
};

test('every response carries the security headers and none carries CORS headers', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  const responses = {
    'status 200': await call(server, 'GET', '/status', { token: VALID, headers: { Origin: 'https://evil.example' } }),
    'code 200': await call(server, 'GET', '/code', { token: VALID }),
    'start 202': await call(server, 'POST', '/start', { token: VALID, body: { mode: 'qr' } }),
    'no token 401': await call(server, 'GET', '/status'),
    'revoked 401': await call(server, 'GET', '/status', { token: REVOKED }),
    'blocked 409': await call(server, 'GET', '/status', { token: BUSY }),
    'rate limited 429': await call(server, 'GET', '/status', { token: LIMITED }),
    'broken 500': await call(server, 'GET', '/status', { token: BROKEN }),
    'unknown path 404': await call(server, 'GET', '/nope', { token: VALID }),
    'wrong method 404': await call(server, 'POST', '/status', { token: VALID, body: {} }),
    'not json 415': await call(server, 'POST', '/start', { token: VALID, headers: { 'Content-Type': 'text/plain' }, raw: 'mode=qr' }),
    'too large 413': await call(server, 'POST', '/start', { token: VALID, raw: JSON.stringify({ mode: 'qr', pad: 'x'.repeat(4000) }) }),
    'bad json 400': await call(server, 'POST', '/start', { token: VALID, raw: '{"mode":' }),
    preflight: await call(server, 'OPTIONS', '/start', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } }),
  };
  for (const [label, response] of Object.entries(responses)) assertSecure(response, label);
  assert.deepEqual(
    Object.fromEntries(Object.entries(responses).map(([label, response]) => [label, response.status])),
    {
      'status 200': 200,
      'code 200': 200,
      'start 202': 202,
      'no token 401': 401,
      'revoked 401': 401,
      'blocked 409': 409,
      'rate limited 429': 429,
      'broken 500': 500,
      'unknown path 404': 404,
      'wrong method 404': 404,
      'not json 415': 415,
      'too large 413': 413,
      'bad json 400': 400,
      preflight: 404,
    },
  );
  assert.deepEqual(globalMiddlewareLeaks, [], 'nothing fell through to the application-wide handlers');
});

test('the token travels only in "Authorization: Bearer": query strings, other headers and bodies are ignored', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  const attempts = [
    call(server, 'GET', `/status?token=${VALID}`),
    call(server, 'GET', `/status?t=${VALID}`),
    call(server, 'GET', '/status', { headers: { apikey: VALID } }),
    call(server, 'GET', '/status', { headers: { 'X-Link-Token': VALID } }),
    call(server, 'GET', '/status', { headers: { Authorization: VALID } }),
    call(server, 'GET', '/status', { headers: { Authorization: `Basic ${VALID}` } }),
    call(server, 'GET', '/status', { headers: { Authorization: `Bearer ${VALID}extra` } }),
    call(server, 'GET', '/status', { headers: { Authorization: `Bearer ${VALID.slice(1)}` } }),
    call(server, 'GET', '/status', { headers: { Authorization: 'Bearer ' } }),
  ];
  for (const response of await Promise.all(attempts)) assert.equal(response.status, 401);
  assert.deepEqual(calls, [], 'none of them reached the service');
  assert.equal((await call(server, 'GET', '/status', { headers: { Authorization: `bearer ${VALID}` } })).status, 200);
});

test('every unusable token is answered with exactly the same bytes, whatever the reason', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  const unusable = [
    await call(server, 'GET', '/status'),
    await call(server, 'GET', '/status', { token: 'short' }),
    await call(server, 'GET', '/status', { token: REVOKED }),
    await call(server, 'GET', '/code', { token: REVOKED }),
    await call(server, 'POST', '/start', { token: REVOKED, body: { mode: 'qr' } }),
    await call(server, 'POST', '/start', { body: { mode: 'qr' } }),
    await call(server, 'POST', '/start', { body: [] }),
  ];
  assert.ok(unusable.every((response) => response.status === 401));
  assert.equal(new Set(unusable.map((response) => response.text)).size, 1);
  assert.deepEqual(unusable[0].body, { error: 'invalid_link', message: 'Enlace inválido o vencido.' });
});

test('GET status and code only read: they never reach start and a GET /start does not exist', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  await call(server, 'GET', '/status', { token: VALID });
  await call(server, 'GET', '/code', { token: VALID });
  await call(server, 'HEAD', '/status', { token: VALID });
  assert.ok(calls.every(([name]) => name === 'status' || name === 'code'));
  const get = await call(server, 'GET', '/start', { token: VALID });
  const crawler = await call(server, 'GET', '/status');
  assert.equal(get.status, 404);
  assert.equal(crawler.status, 401, 'a link preview (no Authorization header) can neither read nor start anything');
  assert.ok(!calls.some(([name]) => name === 'start'));
});

test('start: JSON object only, parsed by the router itself, passed through untouched to the service', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  const ok = await call(server, 'POST', '/start', { token: VALID, body: { mode: 'code', number: '+52 462 123 4567', ignored: 'x' } });
  assert.equal(ok.status, 202);
  assert.deepEqual(ok.body, { attempt: { ok: 'start', mode: 'code' } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[2])), { mode: 'code', number: '+52 462 123 4567' }, 'only mode and number are forwarded');

  const before = calls.length;
  for (const raw of ['[]', '"text"', '42', 'null', 'true']) {
    const response = await call(server, 'POST', '/start', { token: VALID, raw });
    assert.ok([400].includes(response.status), `${raw} -> ${response.status}`);
  }
  assert.equal(calls.length, before);

  assert.equal((await call(server, 'POST', '/start', { token: VALID, raw: JSON.stringify({ mode: 'qr', pad: 'x'.repeat(1900) }) })).status, 202, 'just under 2 KB is fine');
  assert.equal((await call(server, 'POST', '/start', { token: VALID, raw: JSON.stringify({ mode: 'qr', pad: 'x'.repeat(2100) }) })).status, 413);
  assert.equal((await call(server, 'POST', '/start', { token: VALID, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, raw: 'mode=qr' })).status, 415);
});

test('service errors keep their status and retry hint; unexpected ones are generic and leak nothing', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  const limited = await call(server, 'GET', '/status', { token: LIMITED });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '90');
  assert.deepEqual(limited.body, { error: 'rate_limited', message: 'message for rate_limited' });

  const busy = await call(server, 'GET', '/status', { token: BUSY });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'has_session');

  const broken = await call(server, 'GET', '/status', { token: BROKEN });
  assert.equal(broken.status, 500);
  assert.ok(!broken.text.includes('hunter2'));
  assert.ok(!broken.text.includes('database'));
  assert.deepEqual(globalMiddlewareLeaks, [], 'the global error handler (and its webhook) never saw it');
  assert.ok(!JSON.stringify(logs).includes('hunter2'), 'the error message is not logged either');
});

test('limits per IP: total requests, starts, and addresses that keep sending tokens that do not exist', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  const as = (ip) => ({ headers: { 'X-Forwarded-For': ip } });

  // 120 requests per minute per address.
  for (let index = 0; index < 120; index++) assert.equal((await call(server, 'GET', '/status', { token: VALID, ...as('198.51.100.1') })).status, 200);
  const over = await call(server, 'GET', '/status', { token: VALID, ...as('198.51.100.1') });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) >= 1);
  assert.equal((await call(server, 'GET', '/status', { token: VALID, ...as('198.51.100.2') })).status, 200, 'other addresses are unaffected');
  clock.now += 61_000;
  assert.equal((await call(server, 'GET', '/status', { token: VALID, ...as('198.51.100.1') })).status, 200, 'the window slides');

  // 10 starts per hour per address.
  reset();
  for (let index = 0; index < 10; index++) {
    assert.equal((await call(server, 'POST', '/start', { token: VALID, body: { mode: 'qr' }, ...as('198.51.100.3') })).status, 202);
    clock.now += 2_000;
  }
  const refused = await call(server, 'POST', '/start', { token: VALID, body: { mode: 'qr' }, ...as('198.51.100.3') });
  assert.equal(refused.status, 429);
  const startCalls = calls.filter(([name]) => name === 'start').length;
  assert.equal(startCalls, 10, 'the eleventh never reached the service');

  // 10 tokens that do not exist cut an address off, even for a valid token, until the window passes.
  reset();
  for (let index = 0; index < 10; index++) assert.equal((await call(server, 'GET', '/status', { token: REVOKED, ...as('198.51.100.4') })).status, 401);
  const cut = await call(server, 'GET', '/status', { token: VALID, ...as('198.51.100.4') });
  assert.equal(cut.status, 429);
  assert.deepEqual(calls.filter(([, token]) => token === VALID), [], 'no database work for an address that is cut off');
  assert.ok(logs.some(([level, entry]) => level === 'warn' && entry.evento === 'ip_bloqueada'));
  assert.equal((await call(server, 'GET', '/status', { token: VALID, ...as('198.51.100.5') })).status, 200);
  clock.now += 15 * 60_000 + 1_000;
  assert.equal((await call(server, 'GET', '/status', { token: VALID, ...as('198.51.100.4') })).status, 200);
});

test('limits cannot be dodged by forging X-Forwarded-For: the trusted hop decides, entries prepended by the client do not', async (t) => {
  reset();
  const server = await startServer({ hops: 1 });
  t.after(() => server.close());
  for (let index = 0; index < 120; index++) {
    await call(server, 'GET', '/status', { token: VALID, headers: { 'X-Forwarded-For': `${index}.${index}.${index}.${index}, 198.51.100.9` } });
  }
  const response = await call(server, 'GET', '/status', { token: VALID, headers: { 'X-Forwarded-For': '1.2.3.4, 198.51.100.9' } });
  assert.equal(response.status, 429, 'same real address, whatever the client prepended');

  const direct = await startServer({ hops: 0 });
  t.after(() => direct.close());
  reset();
  for (let index = 0; index < 120; index++) await call(direct, 'GET', '/status', { token: VALID, headers: { 'X-Forwarded-For': `9.9.9.${index}` } });
  assert.equal((await call(direct, 'GET', '/status', { token: VALID, headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 429, 'with no trusted proxy the header is ignored entirely');
});

test('logs never contain the token, the Authorization header or the phone number', async (t) => {
  reset();
  const server = await startServer();
  t.after(() => server.close());
  await call(server, 'POST', '/start', { token: VALID, body: { mode: 'code', number: '5214621234567' } });
  await call(server, 'GET', '/status', { token: BROKEN });
  for (let index = 0; index < 12; index++) await call(server, 'GET', '/status', { token: REVOKED, headers: { 'X-Forwarded-For': '198.51.100.7' } });
  const text = JSON.stringify(logs);
  assert.ok(logs.length > 0);
  for (const secret of [VALID, BROKEN, REVOKED, 'Bearer', 'Authorization', '5214621234567']) assert.ok(!text.includes(secret), `logged "${secret}"`);
});
