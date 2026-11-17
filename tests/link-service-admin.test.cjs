// LinkService: administration (create / list / revoke), token handling and the guarantees of the read-only endpoints.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createLinkHarness, token: tokenUtils } = require('./helpers/link-harness.cjs');
const { flush } = require('./helpers/monitor-harness.cjs');

const START = Date.parse('2026-10-06T12:00:00Z');
const mockTime = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
const HOUR = 3_600_000;

const expectLinkError = async (promise, code, message) => {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.name, 'LinkError', `unexpected error: ${error?.stack ?? error}`);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return error;
  }
  assert.fail(`expected LinkError ${code}`);
};

// ------------------------------------------------------------------------------------------ create

test('create: the raw token is returned once, the table keeps only its SHA-256', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_PUBLIC_BASE_URL: 'https://enlaces.example.com' } });
  const created = await h.newLink({ displayName: '  Tienda Centro  ' });

  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.path, `/manager/link#t=${created.token}`);
  assert.equal(created.url, `https://enlaces.example.com/manager/link#t=${created.token}`);
  assert.equal(created.displayName, 'Tienda Centro');
  assert.equal(created.state, 'active');

  const row = h.row(created.id);
  assert.equal(row.tokenHash, tokenUtils.hashLinkToken(created.token));
  assert.ok(!JSON.stringify(row).includes(created.token), 'the raw token is not stored anywhere in the row');
  assert.equal(row.expiresAt.getTime(), START + 24 * HOUR, 'default lifetime is 24 hours');
  assert.equal(row.allowReset, false);
  assert.equal(row.expectedNumber, null);
});

test('create: without LINK_PUBLIC_BASE_URL no url is returned (the manager builds it from the login URL)', async (t) => {
  mockTime(t);
  const created = await createLinkHarness().newLink();
  assert.equal(created.url, undefined);
  assert.ok(created.path.startsWith('/manager/link#t='));
});

test('create: lifetime, display name, permissions and expected number are validated', async (t) => {
  mockTime(t);
  const h = createLinkHarness();

  const custom = await h.newLink({ ttlHours: 2, allowReset: true, expectedNumber: '+52 1 462 123 4567' });
  assert.equal(h.row(custom.id).expiresAt.getTime(), START + 2 * HOUR);
  assert.equal(custom.allowReset, true);
  assert.equal(h.row(custom.id).expectedNumber, '524621234567', 'stored in canonical 52+10 form');
  assert.equal(custom.expectedNumber, '+52 ••• ••• 4567', 'listed masked');

  for (const ttlHours of [0, -1, 169, 1000, Number.NaN, Infinity, '24']) {
    await expectLinkError(h.newLink({ ttlHours }), 'bad_request');
  }
  await expectLinkError(h.newLink({ displayName: 'x'.repeat(101) }), 'bad_request');
  await expectLinkError(h.newLink({ displayName: 'a\u0000b' }), 'bad_request');
  await expectLinkError(h.newLink({ displayName: 'a\nb' }), 'bad_request');
  await expectLinkError(h.newLink({ displayName: 42 }), 'bad_request');
  await expectLinkError(h.newLink({ allowReset: 'yes' }), 'bad_request');
  await expectLinkError(h.newLink({ allowReset: 1 }), 'bad_request');
  await expectLinkError(h.newLink({ expectedNumber: 'not a number' }), 'bad_request');
  await expectLinkError(h.newLink({ expectedNumber: '123' }), 'bad_request');
  await expectLinkError(h.newLink({ instanceName: '' }), 'bad_request');
  await expectLinkError(h.newLink({ instanceName: 'nope' }), 'not_found');
  assert.equal(h.prisma.rows.length, 1, 'nothing was created by the rejected requests');
});

test('create: the maximum lifetime is capped at 7 days even if the environment asks for more', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_TOKEN_MAX_TTL_HOURS: '9999', LINK_TOKEN_DEFAULT_TTL_HOURS: '9999' } });
  await expectLinkError(h.newLink({ ttlHours: 169 }), 'bad_request');
  const created = await h.newLink();
  assert.equal(h.row(created.id).expiresAt.getTime(), START + 168 * HOUR);
});

test('create: only Baileys instances that are not already open, and at most five live links per instance', async (t) => {
  mockTime(t);
  const meta = createLinkHarness({ instance: { integration: 'WHATSAPP-BUSINESS' } });
  await expectLinkError(meta.newLink(), 'bad_request');

  const open = createLinkHarness({ initialState: 'open' });
  await expectLinkError(open.newLink(), 'already_linked');

  const h = createLinkHarness();
  for (let index = 0; index < 5; index++) await h.newLink();
  await expectLinkError(h.newLink(), 'too_many_links');
  await h.linkService.revokeLink('link-1');
  await h.newLink(); // revoking frees a slot
  t.mock.timers.tick(25 * HOUR);
  await h.newLink(); // expired links do not count
});

// ------------------------------------------------------------------------------------------ list / revoke

test('list: summaries never contain the token, its hash or the unmasked expected number', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const first = await h.newLink({ expectedNumber: '524621234567', displayName: 'A' });
  await h.newLink();
  const links = await h.linkService.listLinks('link-test');
  assert.equal(links.length, 2);
  const serialized = JSON.stringify(links);
  assert.ok(!serialized.includes(first.token));
  assert.ok(!serialized.includes(h.row(first.id).tokenHash));
  assert.ok(!serialized.includes('524621234567'));
  assert.ok(!/token/i.test(Object.keys(links[0]).join(',')));
  await expectLinkError(h.linkService.listLinks('nope'), 'not_found');
  await expectLinkError(h.linkService.listLinks(''), 'bad_request');
});

test('revoke: idempotent, unknown ids are 404, and a revoked link is indistinguishable from an unknown one', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const created = await h.newLink();

  const first = await h.linkService.revokeLink(created.id);
  assert.equal(first.state, 'revoked');
  const again = await h.linkService.revokeLink(created.id);
  assert.equal(again.state, 'revoked');
  assert.equal(again.revokedAt.getTime(), first.revokedAt.getTime(), 'the original revocation time is kept');

  await expectLinkError(h.linkService.revokeLink('does-not-exist'), 'not_found');
  await expectLinkError(h.linkService.revokeLink(''), 'not_found');
  await expectLinkError(h.linkService.revokeLink(undefined), 'not_found');

  for (const call of [() => h.linkService.status(created.token), () => h.linkService.code(created.token), () => h.linkService.start(created.token, { mode: 'qr' })]) {
    await expectLinkError(call(), 'invalid_link');
  }
});

test('revoke: ends the running attempt (the unpaired socket is disposed and the line closed)', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const created = await h.newLink();
  await h.linkService.start(created.token, { mode: 'code', number: '524621234567' });
  const runtime = h.created[0];
  h.deliverQr(runtime);

  await h.linkService.revokeLink(created.id);
  assert.equal(runtime.disposed, true);
  assert.equal(runtime.stateConnection.state, 'close');
  assert.equal(h.events.filter((event) => event.startsWith('clean:')).length, 2, 'one at start, one when it ended');
});

test('revoke: never disturbs a phone that is already linking', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const created = await h.newLink();
  await h.linkService.start(created.token, { mode: 'code', number: '524621234567' });
  const runtime = h.created[0];
  h.deliverQr(runtime);
  runtime.instance.authState.state.creds = { registered: true }; // the phone accepted the code

  await h.linkService.revokeLink(created.id);
  assert.equal(runtime.disposed, false);
  assert.ok(!h.events.includes('dispose:runtime-1'));
  assert.equal(h.events.filter((event) => event.startsWith('clean:')).length, 1, 'only the one made when the attempt started');
});

// ------------------------------------------------------------------------------------------ authentication

test('every way a token can be unusable yields the very same generic error', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const expired = await h.newLink({ ttlHours: 1 });
  const revoked = await h.newLink();
  const consumed = await h.newLink();
  await h.linkService.revokeLink(revoked.id);
  h.row(consumed.id).consumedAt = new Date(START - 16 * 60_000); // used up, past its 15 minute grace
  t.mock.timers.tick(2 * HOUR);

  const unusable = [
    tokenUtils.generateLinkToken(), // never existed
    expired.token,
    revoked.token,
    consumed.token,
    'short',
    '',
    undefined,
    null,
    42,
    `${expired.token}x`,
    expired.token.slice(1),
  ];
  const seen = new Set();
  for (const candidate of unusable) {
    for (const call of [
      () => h.linkService.status(candidate),
      () => h.linkService.code(candidate),
      () => h.linkService.start(candidate, { mode: 'qr' }),
    ]) {
      const error = await expectLinkError(call(), 'invalid_link');
      seen.add(JSON.stringify([error.code, error.message, error.status, error.retryAfterMs]));
    }
  }
  assert.equal(seen.size, 1, `the error must be byte-identical, got ${[...seen].join(' | ')}`);
  assert.equal([...seen][0], '["invalid_link","Enlace inválido o vencido.",401,null]');
});

test('a link of another client (same database, different CLIENT_NAME) is not served', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const created = await h.newLink();
  h.instanceRow.clientName = 'another-client';
  await expectLinkError(h.linkService.status(created.token), 'invalid_link');
});

// ------------------------------------------------------------------------------------------ read-only guarantees

test('status and code are read-only while the line is closed: no database writes, no runtime, no WhatsApp', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const created = await h.newLink();
  const writesBefore = h.prisma.calls.updateMany + h.prisma.calls.create;

  for (let index = 0; index < 5; index++) {
    const status = await h.linkService.status(created.token);
    assert.equal(status.link.state, 'active');
    assert.deepEqual(JSON.parse(JSON.stringify(status.line)), { state: 'close', canStart: true, blocked: null });
    assert.equal(status.attempt, null);
    const code = await h.linkService.code(created.token);
    assert.equal(code.state, 'idle');
  }
  await flush();
  assert.equal(h.prisma.calls.updateMany + h.prisma.calls.create, writesBefore);
  assert.equal(h.created.length, 0, 'no runtime was created');
  assert.equal(h.initial.disposed, false);
  assert.deepEqual(h.events, []);
  assert.equal(h.service.reconnectStates.size, 0);
});

test('status and code never expose the instance, tokens, hashes, proxies, webhooks or the raw QR string', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ instance: { name: 'link-test' } });
  const created = await h.newLink({ displayName: 'Tienda', expectedNumber: '524621234567' });
  await h.linkService.start(created.token, { mode: 'code', number: '524621234567' });
  h.deliverQr(h.created[0]);

  const payloads = [await h.linkService.status(created.token), await h.linkService.code(created.token), await h.linkService.start(created.token, { mode: 'code', number: '524621234567' })];
  const text = JSON.stringify(payloads);
  for (const forbidden of [
    created.token,
    h.row(created.id).tokenHash,
    'link-test',
    'instance-1',
    'RAW-QR-STRING',
    'apikey',
    'proxy',
    'webhook',
    'token',
    '524621234567',
    'clientName',
    'test-client',
  ]) {
    assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `public payload leaks "${forbidden}": ${text}`);
  }
  assert.match(text, /Tienda/);
});

test('logs never contain a token or a full phone number', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const created = await h.newLink({ expectedNumber: '524621234567' });
  await h.linkService.start(created.token, { mode: 'code', number: '524621234567' });
  h.deliverQr(h.created[0]);
  await h.linkService.code(created.token);
  await h.linkService.revokeLink(created.id);

  const text = JSON.stringify(h.linkLogs);
  assert.ok(h.linkLogs.length > 0);
  assert.ok(!text.includes(created.token));
  assert.ok(!text.includes(h.row(created.id).tokenHash));
  assert.ok(!text.includes('524621234567'));
  assert.ok(text.includes('4567'), 'only the last four digits are logged');
});

test('describeSessionStore tells where credentials live', () => {
  assert.equal(createLinkHarness().linkService.describeSessionStore(), 'database');
  assert.equal(createLinkHarness({ env: { CACHE_REDIS_ENABLED: 'true', CACHE_REDIS_SAVE_INSTANCES: 'true' } }).linkService.describeSessionStore(), 'redis');
  assert.equal(createLinkHarness({ env: { PROVIDER_ENABLED: 'true' } }).linkService.describeSessionStore(), 'provider');
  assert.equal(createLinkHarness({ env: { DATABASE_SAVE_DATA_INSTANCE: 'false' } }).linkService.describeSessionStore(), 'none');
});
