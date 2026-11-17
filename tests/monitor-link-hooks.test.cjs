// The monitor's hooks for the self-service link: a guard that shares the critical section with the reconnect, session
// cleaning between dispose and connect, the paired-session signal, read-only snapshots, abort and the open listener.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHarness, flush, NAME, INSTANCE_ID, monitorModule } = require('./helpers/monitor-harness.cjs');

const PHONE = '524621234567';
const mockTimers = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

// -------------------------------------------------------------------------------------------- paired-session signal

test('sessionCredsArePaired: registered (code flow) or account (both flows) means paired; garbage never means unpaired', () => {
  const { sessionCredsArePaired } = monitorModule;
  const double = (value) => JSON.stringify(JSON.stringify(value)); // Session.creds is encoded twice
  assert.equal(sessionCredsArePaired(null), false);
  assert.equal(sessionCredsArePaired(undefined), false);
  assert.equal(sessionCredsArePaired(''), false);
  assert.equal(sessionCredsArePaired(double({ registered: false, pairingCode: 'ABCD1234', me: { id: '1@s.whatsapp.net', name: '~' } })), false);
  assert.equal(sessionCredsArePaired(double({ registered: true })), true, 'phone submitted the code');
  assert.equal(sessionCredsArePaired(double({ registered: false, account: { details: 'x' } })), true, 'QR pair-success');
  assert.equal(sessionCredsArePaired(JSON.stringify({ registered: true })), true, 'single encoding is tolerated');
  assert.equal(sessionCredsArePaired('{not json'), true);
  assert.equal(sessionCredsArePaired('42'), true);
});

test('isSessionPaired: the live in-memory credentials win; without a runtime session the stored one is read', async () => {
  const h = createHarness();
  assert.equal(await h.service.isSessionPaired(NAME), false, 'no creds in memory, no stored session');

  h.initial.instance.authState.state.creds = { registered: false };
  assert.equal(await h.service.isSessionPaired(NAME), false);
  h.initial.instance.authState.state.creds = { registered: true };
  assert.equal(await h.service.isSessionPaired(NAME), true, 'code accepted by the phone');
  h.initial.instance.authState.state.creds = { registered: false, account: { details: 'x' } };
  assert.equal(await h.service.isSessionPaired(NAME), true, 'QR pair-success leaves registered=false but sets account');

  h.initial.instance.authState = undefined; // runtime that never connected: read what is stored
  h.sessions.set(INSTANCE_ID, JSON.stringify(JSON.stringify({ registered: false, account: {} })));
  assert.equal(await h.service.isSessionPaired(NAME), true);
  h.sessions.set(INSTANCE_ID, JSON.stringify(JSON.stringify({ registered: false })));
  assert.equal(await h.service.isSessionPaired(NAME), false);
});

test('when credentials cannot be inspected (Redis or provider store) the answer is "paired" and nothing is cleaned', async () => {
  for (const env of [
    { CACHE_REDIS_ENABLED: 'true', CACHE_REDIS_SAVE_INSTANCES: 'true' },
    { PROVIDER_ENABLED: 'true' },
    { DATABASE_SAVE_DATA_INSTANCE: 'false' },
  ]) {
    const h = createHarness({ env });
    assert.equal(h.service.usesDatabaseSessions(), false, JSON.stringify(env));
    assert.equal(await h.service.isSessionPaired(NAME), true);
    assert.equal(await h.service.abortUnpairedConnection(NAME), 'unsupported');
    assert.deepEqual(h.events, []);
  }
  // Redis enabled but not used for sessions is fine.
  assert.equal(createHarness({ env: { CACHE_REDIS_ENABLED: 'true' } }).service.usesDatabaseSessions(), true);
});

// -------------------------------------------------------------------------------------------- guard + reset

test('guard: a throwing guard aborts before anything is touched (no dispose, no new runtime, no state change)', async () => {
  const h = createHarness();
  const generationBefore = h.service.lifecycleStates.get(NAME).generation;
  await assert.rejects(
    h.service.reconnectInstanceNow(NAME, PHONE, {
      guard: () => {
        throw new Error('blocked');
      },
    }),
    /blocked/,
  );
  assert.deepEqual(h.events, []);
  assert.equal(h.created.length, 0);
  assert.equal(h.initial.disposed, false);
  assert.equal(h.service.waInstances[NAME], h.initial);
  assert.equal(h.service.lifecycleStates.get(NAME).generation, generationBefore);
  assert.equal(h.service.reconnectStates.has(NAME), false);
});

test('guard: it shares the critical section with the reconnect, so two requests cannot interleave', async () => {
  const h = createHarness();
  const order = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const first = h.service.reconnectInstanceNow(NAME, PHONE, {
    guard: async () => {
      order.push('guard-1:start');
      await gate;
      order.push('guard-1:end');
    },
  });
  const second = h.service.reconnectInstanceNow(NAME, PHONE, {
    guard: () => {
      order.push('guard-2');
      assert.equal(h.created.length, 1, 'the first request has fully finished when the second guard runs');
    },
  });
  await flush();
  assert.deepEqual(order, ['guard-1:start'], 'the second guard waits for the first request');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['guard-1:start', 'guard-1:end', 'guard-2']);
  assert.equal(h.created.length, 2);
});

test("resetCredentials 'unpaired': cleans between disposing the old runtime and creating the new one, and connects with the number", async () => {
  const h = createHarness();
  await h.service.reconnectInstanceNow(NAME, PHONE, { resetCredentials: 'unpaired' });
  assert.deepEqual(h.events, ['dispose:initial', `clean:${NAME}:${INSTANCE_ID}`, 'connect:runtime-1']);
  assert.equal(h.created[0].connectNumber, PHONE);
});

test("resetCredentials 'unpaired': a session that became paired is reconnected as a plain login, never cleaned", async () => {
  for (const creds of [{ registered: true }, { registered: false, account: { details: 'x' } }]) {
    const h = createHarness();
    h.initial.instance.authState.state.creds = creds;
    await h.service.reconnectInstanceNow(NAME, PHONE, { resetCredentials: 'unpaired' });
    assert.ok(!h.events.some((event) => event.startsWith('clean:')), JSON.stringify(creds));
    assert.equal(h.created[0].connectNumber, undefined, 'a login does not take the pairing number');
    assert.ok(h.logs.some(([level, text]) => level === 'warn' && /paired session/.test(text)));
  }
});

test('resetCredentials: an open line is never cleaned, in either mode', async () => {
  for (const mode of ['unpaired', 'any']) {
    const h = createHarness({ initialState: 'open' });
    await h.service.reconnectInstanceNow(NAME, PHONE, { resetCredentials: mode });
    assert.ok(!h.events.some((event) => event.startsWith('clean:')), mode);
  }
});

test("resetCredentials 'any': cleans a paired session on a line that is not open (explicit allowReset)", async () => {
  const h = createHarness();
  h.initial.instance.authState.state.creds = { registered: true, account: {} };
  await h.service.reconnectInstanceNow(NAME, PHONE, { resetCredentials: 'any' });
  assert.deepEqual(h.events, ['dispose:initial', `clean:${NAME}:${INSTANCE_ID}`, 'connect:runtime-1']);
  assert.equal(h.created[0].connectNumber, PHONE);
});

test('retries after a reset never clean the session again', async (t) => {
  mockTimers(t);
  const h = createHarness();
  await h.service.reconnectInstanceNow(NAME, PHONE, { resetCredentials: 'unpaired' });
  const first = h.created[0];
  first.qrCount = 1;
  first.stateConnection = { state: 'close' };
  h.service.scheduleReconnect(NAME, first, { statusCode: 408 });
  t.mock.timers.tick(5001);
  await flush();
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].connectNumber, PHONE, 'the retry keeps the pairing number');
  assert.equal(h.events.filter((event) => event.startsWith('clean:')).length, 1, 'only the first attempt cleaned');
});

test('without options reconnectInstanceNow behaves as before (no cleaning)', async () => {
  const h = createHarness();
  await h.service.reconnectInstanceNow(NAME);
  assert.ok(!h.events.some((event) => event.startsWith('clean:')));
  assert.equal(h.created[0].connectNumber, undefined);
});

// -------------------------------------------------------------------------------------------- snapshot

test('getLineSnapshot: a safe read-only projection; the raw QR string never leaves the monitor', () => {
  const h = createHarness({ initialState: 'connecting' });
  assert.equal(h.service.getLineSnapshot('nope'), null);

  h.initial.qrCount = 3;
  h.initial.pairingCode = 'ABCD1234';
  h.initial.base64 = 'data:image/png;base64,AAAA';
  const snapshot = h.service.getLineSnapshot(NAME);
  assert.equal(snapshot.runtime, h.initial);
  assert.equal(snapshot.state, 'connecting');
  assert.equal(snapshot.integration, 'WHATSAPP-BAILEYS');
  assert.equal(snapshot.reconnecting, false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.qr)), { count: 3, pairingCode: 'ABCD1234', base64: 'data:image/png;base64,AAAA' });
  assert.ok(!JSON.stringify(snapshot.qr).includes('RAW-QR-STRING'));

  h.initial.stateConnection = { state: 'close', requiresManualIntervention: true, reason: 'proxy_unavailable' };
  const closed = h.service.getLineSnapshot(NAME);
  assert.equal(closed.state, 'close');
  assert.equal(closed.requiresManualIntervention, true);
  assert.equal(closed.reason, 'proxy_unavailable');

  h.initial.stateConnection = { state: 'something-else' };
  assert.equal(h.service.getLineSnapshot(NAME).state, 'unknown');

  h.service.waInstances[NAME] = h.service.createReconnectingPlaceholder(NAME, h.initial);
  const placeholder = h.service.getLineSnapshot(NAME);
  assert.equal(placeholder.reconnecting, true);
  assert.equal(placeholder.state, 'connecting');
  assert.equal(placeholder.qr, null);
});

// -------------------------------------------------------------------------------------------- abort

test('abortUnpairedConnection: disposes, cleans and leaves the line closed; a second call is harmless', async () => {
  const h = createHarness({ initialState: 'connecting' });
  h.initial.qrCount = 2;
  const generationBefore = h.service.lifecycleStates.get(NAME).generation;
  assert.equal(await h.service.abortUnpairedConnection(NAME), 'aborted');
  assert.deepEqual(h.events, ['dispose:initial', `clean:${NAME}:${INSTANCE_ID}`]);
  assert.equal(h.initial.stateConnection.state, 'close');
  assert.ok(h.service.lifecycleStates.get(NAME).generation > generationBefore, 'in-flight attempts and stale events are superseded');
  assert.equal(h.service.isRuntimeCurrent(NAME, h.initial), true, 'it stays the registered runtime');
  assert.equal(await h.service.abortUnpairedConnection(NAME), 'aborted', 'idempotent');
});

test('abortUnpairedConnection: refuses an open line, a paired session, a reconnect in progress and an unknown line', async () => {
  const open = createHarness({ initialState: 'open' });
  assert.equal(await open.service.abortUnpairedConnection(NAME), 'open');

  for (const creds of [{ registered: true }, { account: { details: 'x' } }]) {
    const paired = createHarness({ initialState: 'connecting' });
    paired.initial.instance.authState.state.creds = creds;
    assert.equal(await paired.service.abortUnpairedConnection(NAME), 'paired');
    assert.deepEqual(paired.events, []);
    assert.equal(paired.initial.disposed, false);
  }

  const busy = createHarness({ initialState: 'connecting' });
  busy.service.waInstances[NAME] = busy.service.createReconnectingPlaceholder(NAME, busy.initial);
  assert.equal(await busy.service.abortUnpairedConnection(NAME), 'busy');

  assert.equal(await open.service.abortUnpairedConnection('does-not-exist'), 'missing');
  assert.deepEqual(open.events, []);
});

// -------------------------------------------------------------------------------------------- open listener, logout

test('open listeners run for the current runtime only and can never break connection handling', async () => {
  const h = createHarness({ initialState: 'connecting' });
  const seen = [];
  h.service.onInstanceOpen((name, runtime) => {
    seen.push([name, runtime.label]);
  });
  h.service.onInstanceOpen(() => {
    throw new Error('sync failure');
  });
  h.service.onInstanceOpen(async () => {
    throw new Error('async failure');
  });

  const stale = h.makeRuntime('stale');
  stale.lifecycleGeneration = 999;
  h.service.markReconnectSucceeded(NAME, stale);
  assert.deepEqual(seen, [], 'a runtime that is not the current one is ignored');

  h.service.markReconnectSucceeded(NAME, h.initial);
  await flush();
  assert.deepEqual(seen, [[NAME, 'initial']]);
  assert.equal(h.logs.filter(([level, text]) => level === 'error' && /notifyOpen/.test(JSON.stringify(text))).length, 2);
});

test('forceLogout stops reconnecting and logs the session out', async () => {
  const h = createHarness({ initialState: 'open' });
  h.service.reconnectStates.set(NAME, { attempts: 0, halted: false, inProgress: false, pendingReconnect: false });
  await h.service.forceLogout(NAME);
  assert.equal(h.initial.loggedOut, true);
  assert.equal(h.service.reconnectStates.has(NAME), false);
  await h.service.forceLogout('does-not-exist'); // nothing to log out: no error
});
