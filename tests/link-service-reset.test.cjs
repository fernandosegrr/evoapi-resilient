// LinkService: the automatic reset to zero (a new socket and device identity with the same mode and number), run by the
// link service and never by the generic watchdog. Defaults: reset after 120s without progress, at most 2 resets per link,
// 6 attempts per hour, every reset counting as an attempt.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createLinkHarness } = require('./helpers/link-harness.cjs');
const { flush, NAME, INSTANCE_ID } = require('./helpers/monitor-harness.cjs');

const START = Date.parse('2026-10-06T12:00:00Z');
const PHONE = '524621234567';
const RESET_MS = 120_000;
const mockTime = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
const cleanCount = (h) => h.events.filter((event) => event.startsWith('clean:')).length;
const tick = async (t, ms) => {
  t.mock.timers.tick(ms);
  await flush(30);
};

// Starts a code attempt, lets WhatsApp deliver the code and "shows" it to the person (which starts the reset clock).
async function begin(h, options = {}) {
  const link = options.link ?? (await h.newLink(options.linkOptions));
  await h.linkService.start(link.token, options.start ?? { mode: 'code', number: PHONE });
  const runtime = h.created.at(-1);
  h.deliverQr(runtime);
  const shown = await h.linkService.code(link.token);
  assert.equal(shown.state, 'ready');
  return { link, runtime };
}

test('resets when the person made no progress for LINK_RESET_AFTER_SECONDS: new socket, same mode and number', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link, runtime: first } = await begin(h);

  await tick(t, RESET_MS - 1);
  assert.equal(h.created.length, 1, 'nothing happens before the threshold');
  assert.equal(first.disposed, false);

  await tick(t, 1);
  assert.equal(h.created.length, 2);
  assert.equal(first.disposed, true);
  const second = h.created[1];
  assert.equal(second.connectNumber, PHONE, 'same number');
  assert.equal(cleanCount(h), 2, 'the unpaired session was cleaned: a new device identity');
  assert.deepEqual(h.events.slice(-3), ['dispose:runtime-1', `clean:${NAME}:instance-1`, 'connect:runtime-2']);

  const row = h.row(link.id);
  assert.equal(row.autoResets, 1);
  assert.equal(row.attemptCount, 2, 'the reset counts as an attempt');
  assert.equal(row.windowAttempts, 2);
  assert.ok(h.linkLogs.some(([level, entry]) => level === 'warn' && entry.evento === 'reinicio' && entry.numero === '4567'));

  // The page learns about it from `resets`; the new code has its own countdown and its own reset clock.
  const waiting = await h.linkService.code(link.token);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.resets, 1);
  assert.equal(waiting.resetsLeft, 1);
  h.deliverQr(second, { pairingCode: 'NEW00CODE' });
  const ready = await h.linkService.code(link.token);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.pairingCode, 'NEW00CODE');
  assert.equal(ready.expiresInMs, 45_000);
  assert.equal(ready.resetInMs, RESET_MS);
  assert.equal(ready.resets, 1);
  assert.equal((await h.linkService.status(link.token)).link.attemptsLeft, 4);
});

test('a QR attempt resets as a QR attempt (no number appears)', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  await begin(h, { start: { mode: 'qr' } });
  await tick(t, RESET_MS);
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].connectNumber, undefined);
  assert.equal(h.linkService.attempts.get(NAME).mode, 'qr');
});

test('LINK_RESET_AFTER_SECONDS is honoured', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_RESET_AFTER_SECONDS: '30' } });
  await begin(h);
  await tick(t, 29_999);
  assert.equal(h.created.length, 1);
  await tick(t, 1);
  assert.equal(h.created.length, 2);
});

test('the clock starts when the code is SHOWN, not when the attempt starts', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const link = await h.newLink();
  await h.linkService.start(link.token, { mode: 'code', number: PHONE });
  h.deliverQr(h.created[0]);

  await tick(t, 500_000); // WhatsApp has a code but nobody has seen it
  assert.equal(h.created.length, 1, 'no reset clock without a shown code');
  assert.equal(h.row(link.id).autoResets, 0);

  const shown = await h.linkService.code(link.token);
  assert.equal(shown.resetInMs, RESET_MS);
  await tick(t, RESET_MS);
  assert.equal(h.created.length, 2, 'it resets RESET_MS after being shown');
});

test('a renewal on the same socket neither resets nor restarts the reset clock', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link, runtime } = await begin(h);

  await tick(t, 45_000);
  h.deliverQr(runtime, { count: 2, pairingCode: 'RENEW002' });
  const renewed = await h.linkService.code(link.token);
  assert.equal(renewed.pairingCode, 'RENEW002');
  assert.equal(renewed.resetInMs, RESET_MS - 45_000);

  await tick(t, 45_000);
  h.deliverQr(runtime, { count: 3, pairingCode: 'RENEW003' });
  assert.equal(h.created.length, 1, 'two renewals and still the same socket');
  assert.equal(h.row(link.id).autoResets, 0);

  await tick(t, RESET_MS - 90_000);
  assert.equal(h.created.length, 2, 'the reset still happens RESET_MS after the code was first shown');
});

// ------------------------------------------------------------------------------------------ never while the phone links

test('never resets once the phone started to link (registered, account, or a socket being replaced)', async (t) => {
  mockTime(t);
  const scenarios = {
    'code accepted by the phone (registered)': (h, runtime) => {
      runtime.instance.authState.state.creds = { registered: true };
    },
    'QR pair-success (account)': (h, runtime) => {
      runtime.instance.authState.state.creds = { registered: false, account: { details: 'x' } };
    },
    'socket replaced right after pair-success (the stored session is paired)': (h, runtime) => {
      h.service.waInstances[NAME] = h.service.createReconnectingPlaceholder(NAME, runtime);
      h.sessions.set(INSTANCE_ID, JSON.stringify(JSON.stringify({ registered: false, account: { details: 'x' } })));
    },
  };
  for (const [label, makeProgress] of Object.entries(scenarios)) {
    const h = createLinkHarness();
    const { link, runtime } = await begin(h);
    await tick(t, 60_000);
    makeProgress(h, runtime);

    await tick(t, RESET_MS);
    assert.equal(h.created.length, 1, label);
    assert.equal(runtime.disposed, false, label);
    assert.equal(cleanCount(h), 1, `${label}: nothing was cleaned beyond the start`);
    assert.equal(h.row(link.id).autoResets, 0, label);
    assert.equal(h.row(link.id).attemptCount, 1, `${label}: no attempt was spent`);
    assert.equal((await h.linkService.code(link.token)).state, 'finalizing', label);

    await tick(t, 3_600_000); // and it stays that way: the clock is cancelled for good
    assert.equal(h.created.length, 1, label);
    assert.equal(runtime.disposed, false, label);
  }
});

test('progress that appears between the check and the reset still wins: the guard re-checks inside the critical section', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link, runtime } = await begin(h);
  // The phone submits the code at the very moment the timer fires: the first read says "unpaired", the re-check says "paired".
  const original = h.service.isSessionPaired.bind(h.service);
  let reads = 0;
  h.service.isSessionPaired = async (name) => {
    reads++;
    if (reads === 1) runtime.instance.authState.state.creds = { registered: true };
    return original(name);
  };
  await tick(t, RESET_MS);
  assert.equal(h.created.length, 1);
  assert.equal(runtime.disposed, false);
  assert.equal(cleanCount(h), 1);
  assert.equal(h.row(link.id).attemptCount, 1, 'no quota was spent');
  assert.equal((await h.linkService.code(link.token)).state, 'finalizing');
});

test('never acts on a line that is open', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link, runtime } = await begin(h);
  runtime.stateConnection = { state: 'open' }; // it opened, and no notification reached the service yet

  await tick(t, RESET_MS);
  assert.equal(h.created.length, 1);
  assert.equal(runtime.disposed, false);
  assert.equal(runtime.loggedOut, false);
  assert.equal(cleanCount(h), 1);
  assert.equal(h.row(link.id).autoResets, 0);
  assert.equal(h.row(link.id).attemptCount, 1);
});

// ------------------------------------------------------------------------------------------ caps and quotas

test('respects the cap: after LINK_MAX_AUTO_RESETS resets the next timeout ends the attempt instead', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link } = await begin(h);

  for (let expected = 1; expected <= 2; expected++) {
    await tick(t, RESET_MS);
    assert.equal(h.created.length, 1 + expected);
    h.deliverQr(h.created.at(-1), { pairingCode: `CODE000${expected}` });
    assert.equal((await h.linkService.code(link.token)).state, 'ready');
  }
  assert.equal(h.row(link.id).autoResets, 2);
  const third = h.created[2];
  const beforeEnd = await h.linkService.code(link.token);
  assert.equal(beforeEnd.resetsLeft, 0, 'the page can tell nothing more will be regenerated');

  await tick(t, RESET_MS);
  assert.equal(h.created.length, 3, 'no fourth socket');
  assert.equal(third.disposed, true, 'the last socket is ended');
  assert.equal(third.stateConnection.state, 'close');
  assert.equal(h.row(link.id).autoResets, 2);
  assert.equal(h.row(link.id).attemptCount, 3);
  assert.equal(cleanCount(h), 4, 'start + two resets + the final cleanup');

  const code = await h.linkService.code(link.token);
  assert.equal(code.state, 'exhausted');
  assert.equal(code.reason, 'exhausted');
  const status = await h.linkService.status(link.token);
  assert.equal(status.line.blocked, 'resets_exhausted');
  assert.equal(status.line.canStart, false);
  assert.equal(status.attempt, null);
  try {
    await h.linkService.start(link.token, { mode: 'code', number: PHONE });
    assert.fail('start must be refused');
  } catch (error) {
    assert.equal(error.code, 'resets_exhausted');
  }
  assert.equal(h.created.length, 3);
});

test('LINK_MAX_AUTO_RESETS=0 turns the automatic reset off: only the attempt lifetime applies', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_MAX_AUTO_RESETS: '0' } });
  const { link, runtime } = await begin(h);
  const shown = await h.linkService.code(link.token);
  assert.equal(shown.resetInMs, null);
  assert.equal(shown.resetsLeft, 0);
  await tick(t, 599_000);
  assert.equal(h.created.length, 1);
  assert.equal(runtime.disposed, false);
  await tick(t, 1_000);
  assert.equal(runtime.disposed, true, 'the 10 minute lifetime ends it');
  assert.equal(h.created.length, 1);
});

test('every reset spends from the hourly quota: when it is gone the attempt ends instead of resetting', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_ATTEMPTS_PER_HOUR: '2' } });
  const { link } = await begin(h);

  await tick(t, RESET_MS); // reset #1 takes the second (last) attempt of the hour
  assert.equal(h.created.length, 2);
  assert.equal(h.row(link.id).windowAttempts, 2);
  h.deliverQr(h.created[1]);
  await h.linkService.code(link.token);

  await tick(t, RESET_MS);
  assert.equal(h.created.length, 2, 'no third socket');
  assert.equal(h.created[1].disposed, true);
  assert.equal(h.row(link.id).autoResets, 1, 'the refused reset was not counted');
  assert.equal(h.row(link.id).attemptCount, 2);
  const code = await h.linkService.code(link.token);
  assert.equal(code.state, 'failed');
  assert.equal(code.reason, 'rate_limited');
});

test('the lifetime quota also bounds resets', async (t) => {
  mockTime(t);
  const h = createLinkHarness({ env: { LINK_ATTEMPTS_PER_HOUR: '60', LINK_ATTEMPTS_PER_TOKEN: '2', LINK_MAX_AUTO_RESETS: '5' } });
  const { link } = await begin(h);
  await tick(t, RESET_MS);
  assert.equal(h.created.length, 2);
  h.deliverQr(h.created[1]);
  await h.linkService.code(link.token);
  await tick(t, RESET_MS);
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].disposed, true);
  assert.equal(h.row(link.id).attemptCount, 2);
});

// ------------------------------------------------------------------------------------------ idempotency and races

test('idempotent: the same reset requested twice (a double fire) happens once', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link } = await begin(h);
  const attempt = h.linkService.attempts.get(NAME);
  const generation = attempt.generation;

  await Promise.all([h.linkService.autoReset(attempt, generation), h.linkService.autoReset(attempt, generation)]);
  await flush(30);
  assert.equal(h.created.length, 2, 'one new socket, not two');
  assert.equal(h.row(link.id).autoResets, 1);
  assert.equal(h.row(link.id).attemptCount, 2);

  // A timer armed for the previous socket can never reset the new one.
  await h.linkService.autoReset(attempt, generation);
  await flush(30);
  assert.equal(h.created.length, 2);
  assert.equal(h.row(link.id).attemptCount, 2);
});

test('a socket someone else started in the meantime (admin, another start) is left alone', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link } = await begin(h);
  await h.service.reconnectInstanceNow(NAME); // the administrator restarts the line by hand
  assert.equal(h.created.length, 2);

  await tick(t, RESET_MS);
  assert.equal(h.created.length, 2, 'the service does not reset a socket it did not create');
  assert.equal(h.row(link.id).autoResets, 0);
  assert.equal(h.row(link.id).attemptCount, 1);
});

test('revoking the link cancels the pending reset', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link } = await begin(h);
  await h.linkService.revokeLink(link.id);
  const cleans = cleanCount(h);
  await tick(t, RESET_MS * 3);
  assert.equal(h.created.length, 1);
  assert.equal(cleanCount(h), cleans);
});

test('a reset that fails to reconnect ends the attempt cleanly and says so generically', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link } = await begin(h);
  const broken = h.makeRuntime('broken');
  broken.connectToWhatsapp = async () => {
    throw new Error('socket exploded: secret details');
  };
  h.prepared.push(broken);

  await tick(t, RESET_MS);
  assert.ok(h.linkLogs.some(([level, entry]) => level === 'error' && entry.evento === 'reinicio_fallo'));
  assert.equal(h.linkService.attempts.size, 0);
  const code = await h.linkService.code(link.token);
  assert.equal(code.state, 'failed');
  assert.ok(!JSON.stringify(code).includes('secret'));
});

test('everything is cancelled when the phone links: no timer is left that could reset an open line', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link, runtime } = await begin(h);
  runtime.stateConnection = { state: 'open' };
  runtime.client = { user: { id: '5214621234567:5@s.whatsapp.net' } };
  h.service.markReconnectSucceeded(NAME, runtime);
  await flush();
  assert.ok(h.row(link.id).consumedAt);

  await tick(t, 3_600_000);
  assert.equal(h.created.length, 1);
  assert.equal(runtime.disposed, false);
  assert.equal(cleanCount(h), 1);
});

// Found by the live validation. While a reset is in flight the monitor shows a "reconnecting" placeholder; polling the code
// in that instant must not be read as "the phone started to link": the remaining resets and the end of the attempt depend on it.
test('a page poll during a reset does not cancel the resets that follow', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link } = await begin(h);

  let release;
  const gate = new Promise((resolve) => (release = resolve));
  h.service.cleaningUp = async (name, id) => {
    h.events.push(`clean:${name}:${id}`);
    await gate; // keeps the monitor in its placeholder phase
  };
  t.mock.timers.tick(RESET_MS);
  await flush(30);
  assert.equal(h.service.waInstances[NAME].reconnecting, true, 'the reset is in flight');

  const during = await h.linkService.code(link.token);
  assert.equal(during.state, 'waiting');
  assert.equal(h.linkService.attempts.get(NAME).finalizing, false);
  assert.equal((await h.linkService.status(link.token)).line.state, 'connecting');

  release();
  await flush(30);
  assert.equal(h.created.length, 2);
  assert.equal(h.row(link.id).autoResets, 1);
  h.deliverQr(h.created[1], { pairingCode: 'AFTER001' });
  assert.equal((await h.linkService.code(link.token)).state, 'ready');

  await tick(t, RESET_MS);
  assert.equal(h.created.length, 3, 'the second reset still happens');
  assert.equal(h.row(link.id).autoResets, 2);
  h.deliverQr(h.created[2], { pairingCode: 'AFTER002' });
  await h.linkService.code(link.token);

  await tick(t, RESET_MS);
  assert.equal(h.created.length, 3, 'and then, with the cap reached, the attempt ends instead of hanging');
  assert.equal(h.created[2].disposed, true);
  assert.equal((await h.linkService.code(link.token)).state, 'exhausted');
});

test('another reconnect of the line in flight makes the reset wait a few seconds instead of giving up', async (t) => {
  mockTime(t);
  const h = createLinkHarness();
  const { link, runtime } = await begin(h);
  const attempt = h.linkService.attempts.get(NAME);

  h.service.waInstances[NAME] = h.service.createReconnectingPlaceholder(NAME, runtime); // someone else's retry
  await h.linkService.autoReset(attempt, attempt.generation);
  assert.equal(h.created.length, 1, 'no reset while another reconnect is in flight');
  assert.equal(attempt.finalizing, false, 'and the attempt is not marked as finalizing');
  assert.equal(h.row(link.id).attemptCount, 1, 'no attempt was spent');
  assert.ok(attempt.resetTimer, 'it will look again');

  h.service.waInstances[NAME] = runtime;
  await tick(t, 5_000);
  assert.equal(h.created.length, 2, 'the reset happens as soon as the line is free');
});
