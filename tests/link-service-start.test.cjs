// LinkService: starting an attempt, everything that blocks it, quotas, what the page polls, and what happens on open.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createLinkHarness } = require('./helpers/link-harness.cjs');
const { flush, NAME, INSTANCE_ID } = require('./helpers/monitor-harness.cjs');

const START = Date.parse('2026-10-06T12:00:00Z');
const HOUR = 3_600_000;
const PHONE = '524621234567';
const mockTime = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
const plain = (value) => JSON.parse(JSON.stringify(value));

const expectLinkError = async (promise, code) => {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.name, 'LinkError', `unexpected error: ${error?.stack ?? error}`);
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return error;
  }
  assert.fail(`expected LinkError ${code}`);
};
const cleanCount = (h) => h.events.filter((event) => event.startsWith('clean:')).length;

// ------------------------------------------------------------------------------------------ start

test('start (code): reconnects with the normalised number, spends one attempt and registers the attempt', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();

  const attempt = await h.linkService.start(link.token, { mode: 'code', number: '+52 1 462 123 4567' });
  assert.deepEqual(plain(attempt), { mode: 'code', expiresInMs: 600_000, resets: 0, resetsLeft: 2 });
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].connectNumber, PHONE, 'Mexican numbers go out as 52 + 10 digits by default');
  assert.deepEqual(h.events, ['dispose:initial', `clean:${NAME}:${INSTANCE_ID}`, 'connect:runtime-1']);

  const row = h.row(link.id);
  assert.equal(row.attemptCount, 1);
  assert.equal(row.windowAttempts, 1);
  assert.equal(row.windowStartedAt.getTime(), START);
  assert.equal(row.lastAttemptAt.getTime(), START);
  assert.equal(row.autoResets, 0);

  const status = await h.linkService.status(link.token);
  assert.equal(status.attempt.mode, 'code');
  assert.equal(status.line.state, 'connecting');
  assert.equal(status.line.blocked, null);
  assert.equal(status.link.attemptsLeft, 5);
});

test('start (code): the Mexican prefix is configurable and other countries pass through', async (t) => {
  mockTime(t);
  const legacy = createLinkHarness({ env: { LINK_PAIRING_MX_PREFIX: '521' } });
  const link = await legacy.newLink();
  await legacy.linkService.start(link.token, { mode: 'code', number: '524621234567' });
  assert.equal(legacy.created[0].connectNumber, '5214621234567');

  const other = createLinkHarness();
  const otherLink = await other.newLink();
  await other.linkService.start(otherLink.token, { mode: 'code', number: '+1 (415) 555-2671' });
  assert.equal(other.created[0].connectNumber, '14155552671');
});

test('start: bad input is rejected before anything is touched or any attempt is spent', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  for (const number of ['', 'abc', '52 462 123 456', '+52 462 123 4567 ext 9', undefined, null, 12345, '0524621234567']) {
    await expectLinkError(h.linkService.start(link.token, { mode: 'code', number }), 'invalid_number');
  }
  for (const mode of [undefined, null, 'both', 'QR', 1, {}]) {
    await expectLinkError(h.linkService.start(link.token, { mode, number: PHONE }), 'bad_request');
  }
  await expectLinkError(h.linkService.start(link.token, undefined), 'bad_request');
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.events, []);
  assert.equal(h.row(link.id).attemptCount, 0);
});

test('start (qr): needs no number and asks WhatsApp for a plain QR', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  const attempt = await h.linkService.start(link.token, { mode: 'qr', number: PHONE });
  assert.equal(attempt.mode, 'qr');
  assert.equal(h.created[0].connectNumber, undefined, 'a number sent with a QR request is ignored');
});

test('expectedNumber: the page can only ask for that number (52 and 521 are the same line); QR is allowed', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink({ expectedNumber: '5214621234567' });
  await expectLinkError(h.linkService.start(link.token, { mode: 'code', number: '524621234568' }), 'invalid_number');
  await expectLinkError(h.linkService.start(link.token, { mode: 'code', number: '14155552671' }), 'invalid_number');
  assert.equal(h.created.length, 0);
  assert.equal(h.row(link.id).attemptCount, 0);

  await h.linkService.start(link.token, { mode: 'code', number: '5214621234567' });
  assert.equal(h.created.length, 1);
  const qrLink = await h.newLink({ expectedNumber: '524621234567' });
  await h.linkService.revokeLink(link.id);
  await h.linkService.start(qrLink.token, { mode: 'qr' });
  assert.equal(h.created.length, 2);

  const status = await h.linkService.status(qrLink.token);
  assert.equal(status.link.numberHint, '+52 ••• ••• 4567');
});

test('idempotent: a double tap, a second tab or simultaneous requests share one socket and one attempt', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();

  const results = await Promise.all([
    h.linkService.start(link.token, { mode: 'code', number: PHONE }),
    h.linkService.start(link.token, { mode: 'code', number: PHONE }),
    h.linkService.start(link.token, { mode: 'code', number: '+52 462 123 4567' }),
  ]);
  assert.equal(h.created.length, 1, 'one socket, one device identity');
  assert.equal(h.row(link.id).attemptCount, 1, 'one attempt spent');
  assert.ok(results.every((result) => result.mode === 'code'));

  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  assert.equal(h.created.length, 1);
  assert.equal(h.row(link.id).attemptCount, 1);
});

test('a different number or mode is a new attempt: new socket, one more attempt spent', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  await h.linkService.start(link.token, { mode: 'code', number: '524621234568' });
  assert.equal(h.created.length, 2);
  assert.equal(h.created[0].disposed, true);
  assert.equal(h.created[1].connectNumber, '524621234568');
  await h.linkService.start(link.token, { mode: 'qr' });
  assert.equal(h.created.length, 3);
  assert.equal(h.row(link.id).attemptCount, 3);
});

test('one active attempt per instance: another link cannot start until the first ends', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const first = await h.newLink();
  const second = await h.newLink();
  await h.linkService.start(first.token, { mode: 'code', number: PHONE });

  await expectLinkError(h.linkService.start(second.token, { mode: 'qr' }), 'attempt_in_progress');
  const status = await h.linkService.status(second.token);
  assert.equal(status.line.blocked, 'attempt_in_progress');
  assert.equal(status.line.canStart, false);
  assert.equal(h.row(second.id).attemptCount, 0);

  await h.linkService.revokeLink(first.id);
  await h.linkService.start(second.token, { mode: 'qr' });
  assert.equal(h.created.length, 2);

  // And simultaneously: exactly one of two links wins.
  const h2 = createLinkHarness();
  const a = await h2.newLink();
  const b = await h2.newLink();
  const settled = await Promise.allSettled([
    h2.linkService.start(a.token, { mode: 'code', number: PHONE }),
    h2.linkService.start(b.token, { mode: 'code', number: PHONE }),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(settled.find((result) => result.status === 'rejected').reason.code, 'attempt_in_progress');
  assert.equal(h2.created.length, 1);
});

// ------------------------------------------------------------------------------------------ what blocks a start

test('an open line is never touched: no logout, no reconnection, no QR; the link is retired', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ initialState: 'open' });
  // The line opened after the link was created.
  h.initial.stateConnection = { state: 'close' };
  const link = await h.newLink();
  h.initial.stateConnection = { state: 'open' };

  const status = await h.linkService.status(link.token);
  assert.deepEqual(plain(status.line), { state: 'open', canStart: false, blocked: 'already_linked' });
  await flush();
  assert.equal(h.row(link.id).consumedAt.getTime(), START, 'seeing it open consumes the link');

  const again = await h.linkService.status(link.token);
  assert.equal(again.link.state, 'consumed');
  await expectLinkError(h.linkService.start(link.token, { mode: 'qr' }), 'already_linked');
  assert.equal(h.created.length, 0);
  assert.equal(h.initial.disposed, false);
  assert.equal(h.initial.loggedOut, false);
  assert.deepEqual(h.events, []);
});

test('a stored paired session is protected (code flow: registered, QR flow: account, or read from the database)', async (t) => {
  mockTime(t);
  for (const creds of [{ registered: true }, { registered: false, account: { details: 'x' } }]) {
    const h = createLinkHarness();
    const link = await h.newLink();
    h.initial.instance.authState.state.creds = creds;
    const status = await h.linkService.status(link.token);
    assert.equal(status.line.blocked, 'has_session', JSON.stringify(creds));
    assert.equal(status.line.canStart, false);
    await expectLinkError(h.linkService.start(link.token, { mode: 'qr' }), 'has_session');
    assert.deepEqual(h.events, []);
    assert.equal(h.row(link.id).attemptCount, 0);
  }

  const stored = createLinkHarness();
  const link = await stored.newLink();
  stored.initial.instance.authState = undefined;
  stored.sessions.set(INSTANCE_ID, JSON.stringify(JSON.stringify({ registered: false, account: { details: 'x' } })));
  await expectLinkError(stored.linkService.start(link.token, { mode: 'qr' }), 'has_session');
});

test('allowReset replaces a stale paired session on a CLOSED line, with a warning, and only then', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink({ allowReset: true });
  h.initial.instance.authState.state.creds = { registered: true, account: {} };

  const status = await h.linkService.status(link.token);
  assert.equal(status.line.blocked, null);
  assert.equal(status.line.canStart, true);

  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  assert.deepEqual(h.events, ['dispose:initial', `clean:${NAME}:${INSTANCE_ID}`, 'connect:runtime-1']);
  assert.ok(h.linkLogs.some(([level, entry]) => level === 'warn' && entry.evento === 'restablecimiento'));

  // A real reconnection in progress (connecting, with a paired session) is not stale: not even allowReset touches it.
  const busy = createLinkHarness({ initialState: 'connecting' });
  const busyLink = await busy.newLink({ allowReset: true });
  busy.initial.instance.authState.state.creds = { registered: true };
  await expectLinkError(busy.linkService.start(busyLink.token, { mode: 'qr' }), 'reconnecting');
  assert.deepEqual(busy.events, []);

  // Without the permission the very same situation is blocked.
  const without = createLinkHarness();
  const noPermission = await without.newLink();
  without.initial.instance.authState.state.creds = { registered: true };
  await expectLinkError(without.linkService.start(noPermission.token, { mode: 'qr' }), 'has_session');
});

test('a reconnection in progress is never interrupted', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ initialState: 'connecting' });
  const link = await h.newLink();
  h.service.waInstances[NAME] = h.service.createReconnectingPlaceholder(NAME, h.initial);
  const status = await h.linkService.status(link.token);
  assert.equal(status.line.blocked, 'reconnecting');
  await expectLinkError(h.linkService.start(link.token, { mode: 'qr' }), 'reconnecting');
  assert.deepEqual(h.events, []);
});

test('an unfinished pairing of someone else (admin, boot) is taken over, cleaning only the unpaired session', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ initialState: 'connecting' });
  h.initial.qrCount = 3;
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'qr' });
  assert.equal(h.initial.disposed, true);
  assert.equal(cleanCount(h), 1);
  assert.equal(h.created.length, 1);
});

test('a line given up because its proxy is down cannot link; any other manual-intervention reason can', async (t) => {
  mockTime(t);
  const inMemory = createLinkHarness();
  const link = await inMemory.newLink();
  inMemory.initial.stateConnection = { state: 'close', requiresManualIntervention: true, reason: 'proxy_unavailable' };
  const status = await inMemory.linkService.status(link.token);
  assert.equal(status.line.blocked, 'unavailable');
  await expectLinkError(inMemory.linkService.start(link.token, { mode: 'qr' }), 'unavailable');

  // After a restart the reason only survives in the database.
  const restarted = createLinkHarness({
    instance: { disconnectionObject: { requiresManualIntervention: true, reason: 'proxy_unavailable', reconnectAttempts: 6 } },
  });
  const restartedLink = await restarted.newLink();
  assert.equal((await restarted.linkService.status(restartedLink.token)).line.blocked, 'unavailable');

  const exhausted = createLinkHarness();
  const exhaustedLink = await exhausted.newLink();
  exhausted.initial.stateConnection = { state: 'close', requiresManualIntervention: true, reason: 'automatic_reconnect_exhausted' };
  await exhausted.linkService.start(exhaustedLink.token, { mode: 'qr' });
  assert.equal(exhausted.created.length, 1);
});

test('without database-stored sessions, or on a non-Baileys runtime, the link refuses to act', async (t) => {
  mockTime(t);
  const redis = createLinkHarness({ env: { CACHE_REDIS_ENABLED: 'true', CACHE_REDIS_SAVE_INSTANCES: 'true' } });
  const redisLink = await redis.newLink();
  assert.equal((await redis.linkService.status(redisLink.token)).line.blocked, 'unavailable');
  await expectLinkError(redis.linkService.start(redisLink.token, { mode: 'qr' }), 'unavailable');
  assert.deepEqual(redis.events, []);

  const meta = createLinkHarness();
  const metaLink = await meta.newLink();
  meta.initial.integration = 'WHATSAPP-BUSINESS';
  await expectLinkError(meta.linkService.start(metaLink.token, { mode: 'qr' }), 'unavailable');
});

test('a failure while connecting is reported generically and leaves no attempt behind', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  const failing = h.makeRuntime('broken');
  failing.connectToWhatsapp = async () => {
    throw new Error('socket exploded: secret details');
  };
  h.prepared.push(failing);
  const error = await expectLinkError(h.linkService.start(link.token, { mode: 'qr' }), 'unavailable');
  assert.ok(!error.message.includes('secret'));
  assert.equal(h.linkService.attempts.size, 0);
  assert.equal((await h.linkService.code(link.token)).state, 'idle');
});

// ------------------------------------------------------------------------------------------ quotas

test('quota: 6 attempts per hour (resets included), then rate_limited with the wait; the window slides', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  for (let index = 0; index < 6; index++) {
    await h.linkService.start(link.token, { mode: 'code', number: `52462123456${index}` });
    t.mock.timers.tick(60_000);
  }
  assert.equal(h.row(link.id).attemptCount, 6);

  const error = await expectLinkError(h.linkService.start(link.token, { mode: 'code', number: '524621239999' }), 'rate_limited');
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, HOUR - 6 * 60_000, 'waits for the window opened by the first attempt');
  assert.equal(h.created.length, 6, 'a refused attempt creates nothing');
  assert.equal(h.row(link.id).attemptCount, 6);
  assert.equal((await h.linkService.status(link.token)).link.attemptsLeft, 0);

  t.mock.timers.tick(HOUR - 6 * 60_000);
  await h.linkService.start(link.token, { mode: 'code', number: '524621239999' });
  assert.equal(h.row(link.id).attemptCount, 7);
  assert.equal(h.row(link.id).windowAttempts, 1, 'a new window started');
});

test('quota: 12 attempts for the life of the link, then attempts_exhausted', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_ATTEMPTS_PER_HOUR: '60' } });
  const link = await h.newLink();
  for (let index = 0; index < 12; index++) {
    await h.linkService.start(link.token, { mode: 'code', number: `5246212345${String(index).padStart(2, '0')}` });
  }
  await expectLinkError(h.linkService.start(link.token, { mode: 'code', number: '524621239999' }), 'attempts_exhausted');
  t.mock.timers.tick(2 * HOUR);
  await expectLinkError(h.linkService.start(link.token, { mode: 'code', number: '524621239999' }), 'attempts_exhausted');
  assert.equal(h.created.length, 12);
});

test('quota: the counter is a conditional update, so concurrent requests cannot take the last slots', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => h.linkService.consumeAttempt(link.id, 'start')));
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 6);
  assert.equal(h.row(link.id).attemptCount, 6);
  assert.equal(h.row(link.id).windowAttempts, 6);
  assert.ok(outcomes.filter((outcome) => !outcome.ok).every((outcome) => outcome.reason === 'hourly'));
});

// ------------------------------------------------------------------------------------------ what the page polls

test('code: waiting, then the pairing code only (never the raw QR string), counting down and renewing on the same socket', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  assert.equal((await h.linkService.code(link.token)).state, 'idle');

  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  assert.equal((await h.linkService.code(link.token)).state, 'waiting', 'WhatsApp has not delivered a code yet');

  const runtime = h.created[0];
  h.deliverQr(runtime, { count: 1, pairingCode: 'AB12CD34' });
  const first = await h.linkService.code(link.token);
  assert.equal(first.state, 'ready');
  assert.equal(first.pairingCode, 'AB12CD34');
  assert.equal(first.qr, undefined, 'a code-mode attempt never sees the QR image');
  assert.equal(first.expiresInMs, 45_000);
  assert.equal(first.resetInMs, 120_000);
  assert.ok(!JSON.stringify(first).includes('RAW-QR-STRING'));

  t.mock.timers.tick(30_000);
  const later = await h.linkService.code(link.token);
  assert.equal(later.expiresInMs, 15_000);
  assert.equal(later.resetInMs, 90_000);

  // Baileys renews the code on the same socket: new countdown, same reset clock.
  h.deliverQr(runtime, { count: 2, pairingCode: 'ZZ99YY88' });
  const renewed = await h.linkService.code(link.token);
  assert.equal(renewed.pairingCode, 'ZZ99YY88');
  assert.equal(renewed.expiresInMs, 45_000);
  assert.equal(renewed.resetInMs, 90_000, 'a renewal does not restart the reset clock');

  t.mock.timers.tick(60_000);
  assert.equal((await h.linkService.code(link.token)).expiresInMs, 0, 'never negative');
});

test('code (qr mode): only the QR image, validated by the page, never the pairing code or the raw string', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'qr' });
  h.deliverQr(h.created[0], { count: 1, pairingCode: 'AB12CD34', base64: 'data:image/png;base64,QUJDREVG' });
  const ready = await h.linkService.code(link.token);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.qr, 'data:image/png;base64,QUJDREVG');
  assert.equal(ready.pairingCode, undefined);
});

test('code: another link cannot read the attempt of this one', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const mine = await h.newLink();
  const other = await h.newLink();
  await h.linkService.start(mine.token, { mode: 'code', number: PHONE });
  h.deliverQr(h.created[0]);
  assert.equal((await h.linkService.code(mine.token)).state, 'ready');
  const seen = await h.linkService.code(other.token);
  assert.equal(seen.state, 'idle');
  assert.equal(seen.pairingCode, undefined);
});

test('code: once the phone starts linking the state is finalizing, whichever flow it came from', async (t) => {
  mockTime(t);
  for (const creds of [{ registered: true }, { account: { details: 'x' } }]) {
    const h = createLinkHarness();
    const link = await h.newLink();
    await h.linkService.start(link.token, { mode: 'code', number: PHONE });
    h.deliverQr(h.created[0]);
    assert.equal((await h.linkService.code(link.token)).state, 'ready');
    h.created[0].instance.authState.state.creds = creds;
    const finalizing = await h.linkService.code(link.token);
    assert.equal(finalizing.state, 'finalizing');
    assert.equal(finalizing.pairingCode, undefined);
    assert.equal(finalizing.resetInMs, null);
    assert.equal((await h.linkService.status(link.token)).line.state, 'finalizing');
  }

  // The socket restarts right after pair-success: the placeholder has no credentials in memory, so what says "the phone
  // linked" is the stored session, which pair-success has just paired.
  const h = createLinkHarness();
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  h.deliverQr(h.created[0]);
  h.service.waInstances[NAME] = h.service.createReconnectingPlaceholder(NAME, h.created[0]);
  h.sessions.set(INSTANCE_ID, JSON.stringify(JSON.stringify({ registered: false, account: { details: 'x' } })));
  assert.equal((await h.linkService.code(link.token)).state, 'finalizing');
  assert.equal((await h.linkService.status(link.token)).line.state, 'finalizing');
});

// Found by the live validation: during a reset the monitor swaps the runtime for a "reconnecting" placeholder, and a page
// poll in that instant was read as "the phone started to link", which cancelled the resets that followed.
test('a socket of ours being replaced WITHOUT a paired session is not the phone linking', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  h.deliverQr(h.created[0]);
  assert.equal((await h.linkService.code(link.token)).state, 'ready');
  h.service.waInstances[NAME] = h.service.createReconnectingPlaceholder(NAME, h.created[0]);

  const code = await h.linkService.code(link.token);
  assert.equal(code.state, 'waiting', 'no code while the new socket is being created');
  assert.equal(h.linkService.attempts.get(NAME).finalizing, false);
  const status = await h.linkService.status(link.token);
  assert.deepEqual(plain(status.line), { state: 'connecting', canStart: true, blocked: null });
  assert.ok(status.attempt, 'the attempt is still there');
});

// ------------------------------------------------------------------------------------------ open

test('open: every active link of the line is consumed, the attempt is dropped and the link reads "linked"', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const used = await h.newLink();
  const spare = await h.newLink();
  await h.linkService.start(used.token, { mode: 'qr' });
  const runtime = h.created[0];
  h.deliverQr(runtime);
  runtime.stateConnection = { state: 'open' };
  runtime.client = { user: { id: '5214621234567:9@s.whatsapp.net' } };

  h.service.markReconnectSucceeded(NAME, runtime);
  await flush();
  assert.equal(h.row(used.id).consumedAt.getTime(), START);
  assert.equal(h.row(spare.id).consumedAt.getTime(), START);
  assert.equal(h.linkService.attempts.size, 0);
  assert.equal(runtime.loggedOut, false);

  const code = await h.linkService.code(used.token);
  assert.equal(code.state, 'linked');
  const status = await h.linkService.status(used.token);
  assert.equal(status.link.state, 'consumed');
  assert.deepEqual(plain(status.line), { state: 'open', canStart: false, blocked: 'already_linked' });
  await expectLinkError(h.linkService.start(used.token, { mode: 'qr' }), 'already_linked');

  t.mock.timers.tick(16 * 60_000); // past the 15 minute read-only grace
  await expectLinkError(h.linkService.status(used.token), 'invalid_link');
});

test('open + expectedNumber: the same line in its 52 or 521 spelling is accepted', async (t) => {
  mockTime(t);
  for (const jid of ['524621234567@s.whatsapp.net', '5214621234567:3@s.whatsapp.net']) {
    const h = createLinkHarness();
    const link = await h.newLink({ expectedNumber: '5214621234567' });
    await h.linkService.start(link.token, { mode: 'code', number: PHONE });
    const runtime = h.created[0];
    runtime.stateConnection = { state: 'open' };
    runtime.client = { user: { id: jid } };
    h.service.markReconnectSucceeded(NAME, runtime);
    await flush();
    assert.ok(h.row(link.id).consumedAt, jid);
    assert.equal(runtime.loggedOut, false, jid);
    assert.equal(h.row(link.id).revokedAt, null);
  }
});

test('open + expectedNumber: another account opens the line -> logout, link revoked, warning with last digits only', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink({ expectedNumber: '524621234567' });
  const other = await h.newLink();
  await h.linkService.start(link.token, { mode: 'qr' });
  const runtime = h.created[0];
  runtime.stateConnection = { state: 'open' };
  runtime.client = { user: { id: '5215599998888:2@s.whatsapp.net' } };

  h.service.markReconnectSucceeded(NAME, runtime);
  await flush();
  assert.equal(runtime.loggedOut, true, 'the foreign session is logged out');
  assert.ok(h.row(link.id).revokedAt, 'the link is revoked');
  assert.equal(h.row(link.id).consumedAt, null);
  assert.equal(h.row(other.id).consumedAt, null, 'unrelated links are left alone');
  assert.equal(h.linkService.attempts.size, 0);

  const warning = h.linkLogs.find(([level, entry]) => level === 'warn' && entry.evento === 'dueno_distinto');
  assert.ok(warning);
  assert.deepEqual(plain([warning[1].esperado, warning[1].obtenido]), ['4567', '8888']);
  assert.ok(!JSON.stringify(h.linkLogs).includes('5215599998888'));
});

test('open + expectedNumber: an owner that cannot be read fails closed', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink({ expectedNumber: '524621234567' });
  await h.linkService.start(link.token, { mode: 'qr' });
  const runtime = h.created[0];
  runtime.stateConnection = { state: 'open' };
  h.service.markReconnectSucceeded(NAME, runtime);
  await flush();
  assert.equal(runtime.loggedOut, true);
  assert.ok(h.row(link.id).revokedAt);
});

test('open: a line linked by the administrator himself consumes the links without verifying anyone', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink({ expectedNumber: '524621234567' });
  h.initial.stateConnection = { state: 'open' };
  h.initial.client = { user: { id: '5215599998888:2@s.whatsapp.net' } };
  h.service.markReconnectSucceeded(NAME, h.initial);
  await flush();
  assert.ok(h.row(link.id).consumedAt);
  assert.equal(h.initial.loggedOut, false);
});

test('open: simultaneous notifications (listener + a poll) act once', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink({ expectedNumber: '524621234567' });
  await h.linkService.start(link.token, { mode: 'qr' });
  const runtime = h.created[0];
  let logouts = 0;
  runtime.logoutInstance = async () => {
    logouts++;
  };
  runtime.stateConnection = { state: 'open' };
  runtime.client = { user: { id: '5215599998888@s.whatsapp.net' } };

  h.service.markReconnectSucceeded(NAME, runtime);
  await Promise.all([h.linkService.status(link.token).catch(() => undefined), h.linkService.code(link.token).catch(() => undefined)]);
  await flush();
  assert.equal(logouts, 1);
});

test('open: a database failure while consuming is logged and never breaks the connection handler', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  await h.newLink();
  h.prisma.linkToken.findMany = async () => {
    throw new Error('database down');
  };
  h.initial.stateConnection = { state: 'open' };
  h.service.markReconnectSucceeded(NAME, h.initial);
  await flush();
  assert.ok(h.linkLogs.some(([level, entry]) => level === 'error' && entry.evento === 'apertura_fallo'));
});

// ------------------------------------------------------------------------------------------ attempt lifetime

test('an attempt nobody completes ends after LINK_ATTEMPT_TTL_SECONDS: socket disposed, session cleaned, line closed', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_MAX_AUTO_RESETS: '0' } });
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  const runtime = h.created[0];
  h.deliverQr(runtime);

  t.mock.timers.tick(599_999);
  await flush();
  assert.equal(runtime.disposed, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(runtime.disposed, true);
  assert.equal(runtime.stateConnection.state, 'close');
  assert.equal(cleanCount(h), 2);

  const code = await h.linkService.code(link.token);
  assert.equal(code.state, 'failed');
  assert.equal(code.reason, 'expired');
  assert.equal((await h.linkService.status(link.token)).attempt, null);
});

test('an attempt whose phone is already linking is not ended by the lifetime limit', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_MAX_AUTO_RESETS: '0' } });
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  const runtime = h.created[0];
  h.deliverQr(runtime);
  runtime.instance.authState.state.creds = { registered: true };

  t.mock.timers.tick(600_000);
  await flush();
  assert.equal(runtime.disposed, false);
  assert.equal(cleanCount(h), 1, 'only the clean made when the attempt started');
  assert.equal((await h.linkService.code(link.token)).state, 'finalizing');
});
