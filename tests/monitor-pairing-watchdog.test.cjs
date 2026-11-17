// Regression tests for the reconnect watchdog (src/api/services/monitor.service.ts) around QR / pairing waits.
//
// The whole file runs with WA_RECONNECT_ATTEMPT_TIMEOUT_MS=20000, the production value (the code default is 45000),
// read through the real ConfigService so the env var -> 20s mapping is part of what is verified. Timers are mocked;
// the monitor is the real class, only its collaborators (Prisma, the channel factory, Baileys runtimes) are fakes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const PRODUCTION_TIMEOUT_MS = 20000;
const NAME = 'watchdog-test';
const PHONE = '5215512345678';

function loadTs(file, stubs = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (name) => (name in stubs ? stubs[name] : require(name)),
    process,
    console,
    // Resolved at call time so node:test's mock timers (installed per test) are what the service sees.
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
  });
  return module.exports;
}

const { ConfigService } = loadTs('src/config/env.config.ts', { dotenv: { config() {} } });

const harnessState = { factory: null, logs: null };
class FakeLogger {
  info(message) {
    harnessState.logs?.push(['info', message]);
  }
  warn(message) {
    harnessState.logs?.push(['warn', message]);
  }
  error(message) {
    harnessState.logs?.push(['error', message]);
  }
  log(message) {
    harnessState.logs?.push(['log', message]);
  }
}
class HttpError extends Error {}
const { WAMonitoringService } = loadTs('src/api/services/monitor.service.ts', {
  '@api/server.module': { channelController: { init: (data) => harnessState.factory(data) } },
  '@api/types/wa.types': {
    Events: new Proxy({}, { get: (_target, key) => String(key) }),
    Integration: { WHATSAPP_BAILEYS: 'WHATSAPP-BAILEYS' },
  },
  '@config/logger.config': { Logger: FakeLogger },
  '@config/path.config': { INSTANCE_DIR: '/tmp/instances', STORE_DIR: '/tmp/store' },
  '@exceptions': { BadRequestException: HttpError, NotFoundException: HttpError },
  eventemitter2: { default: class {} },
});

// What Baileys' ChannelStartupService exposes to the monitor. qrCount mirrors instance.qrcode.count, which the real
// connectionUpdate increments on every `qr` event; stateConnection.state is 'connecting' while waiting for the phone.
function makeRuntime(label) {
  return {
    label,
    disposed: false,
    disposeReason: undefined,
    connectCalls: 0,
    connectNumber: undefined,
    connectGate: null,
    qrCount: 0,
    emitQrOnConnect: false,
    stateConnection: { state: 'connecting' },
    localProxy: { enabled: false },
    instance: { authState: { state: { creds: {} } } },
    get connectionStatus() {
      return this.stateConnection;
    },
    get qrCode() {
      return { count: this.qrCount };
    },
    setInstance(data) {
      this.instanceName = data.instanceName;
      this.instanceId = data.instanceId;
    },
    async connectToWhatsapp(number) {
      this.connectCalls++;
      this.connectNumber = number;
      if (this.emitQrOnConnect) this.qrCount = 1;
      if (this.connectGate) await this.connectGate;
    },
    async disposeConnection(reason) {
      this.disposed = true;
      this.disposeReason = reason;
    },
    async sendDataWebhook() {},
  };
}

function harness({ timeoutMs = PRODUCTION_TIMEOUT_MS } = {}) {
  process.env.WA_RECONNECT_ATTEMPT_TIMEOUT_MS = String(timeoutMs);
  process.env.WA_RECONNECT_JITTER_FACTOR = '0.0001'; // backoff is 5000ms +- 1ms
  const configService = new ConfigService();
  const logs = [];
  const created = [];
  const prepared = [];
  harnessState.logs = logs;
  harnessState.factory = () => {
    const runtime = prepared.shift() ?? makeRuntime(`runtime-${created.length + 1}`);
    created.push(runtime);
    return runtime;
  };
  const stored = {
    id: 'instance-1',
    name: NAME,
    integration: 'WHATSAPP-BAILEYS',
    token: 'token',
    number: null,
    businessId: null,
    ownerJid: null,
  };
  const prisma = {
    instance: {
      findFirst: async () => stored,
      update: async () => stored,
      updateMany: async () => ({ count: 1 }),
    },
  };
  const service = new WAMonitoringService({ on() {} }, configService, prisma, null, null, null, null);
  const initial = makeRuntime('initial');
  initial.stateConnection = { state: 'close' };
  service.registerNewInstanceRuntime(NAME, initial);
  return {
    service,
    initial,
    created,
    prepared,
    logs,
    prisma,
    attempts: () => service.reconnectStates.get(NAME)?.attempts,
    watchdogWarnings: () => logs.filter(([level, text]) => level === 'warn' && /never reached open\/close/.test(text)),
  };
}

const flush = async (rounds = 12) => {
  for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve));
};
const mockTimers = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

test.afterEach(() => {
  delete process.env.WA_RECONNECT_ATTEMPT_TIMEOUT_MS;
  delete process.env.WA_RECONNECT_JITTER_FACTOR;
});

test('the production value reaches the monitor as 20000ms, and the minimum clamp still applies', () => {
  assert.equal(harness().service.getReconnectConfig().attemptTimeoutMs, 20000);
  assert.equal(harness({ timeoutMs: 1000 }).service.getReconnectConfig().attemptTimeoutMs, 5000);
  assert.equal(harness({ timeoutMs: 45000 }).service.getReconnectConfig().attemptTimeoutMs, 45000);
});

for (const timeoutMs of [PRODUCTION_TIMEOUT_MS, 45000]) {
  test(`watchdog (${timeoutMs}ms): a runtime that emitted a QR is left alone, now and minutes later`, async (t) => {
    mockTimers(t);
    const h = harness({ timeoutMs });
    await h.service.reconnectInstanceNow(NAME, PHONE); // what GET /instance/connect does from the "close" state
    const runtime = h.created[0];
    runtime.qrCount = 1; // WhatsApp delivered the first QR / the pairing code was requested

    t.mock.timers.tick(timeoutMs);
    await flush();
    assert.equal(runtime.disposed, false);
    assert.equal(h.service.waInstances[NAME], runtime);
    assert.equal(h.attempts(), 0, 'no reconnect attempt may be consumed by a healthy QR wait');
    assert.equal(h.watchdogWarnings().length, 0);

    t.mock.timers.tick(10 * 60 * 1000);
    await flush();
    assert.equal(runtime.disposed, false);
    assert.equal(h.service.waInstances[NAME], runtime);
    assert.equal(h.created.length, 1, 'no replacement runtime may be created');
    assert.equal(h.attempts(), 0);
  });

  test(`watchdog (${timeoutMs}ms): a hung proxy (no QR ever emitted) is still caught, and the retry keeps the number`, async (t) => {
    mockTimers(t);
    const h = harness({ timeoutMs });
    await h.service.reconnectInstanceNow(NAME, PHONE);
    const stuck = h.created[0];
    assert.equal(stuck.qrCount, 0);

    t.mock.timers.tick(timeoutMs - 1);
    await flush();
    assert.equal(stuck.disposed, false, 'it must not fire before the threshold');

    t.mock.timers.tick(1);
    await flush();
    assert.equal(stuck.disposed, true);
    assert.match(stuck.disposeReason, /never reached open\/close/);
    assert.equal(h.watchdogWarnings().length, 1);
    assert.equal(h.attempts(), 1);

    t.mock.timers.tick(5001); // backoff for attempt 1
    await flush();
    assert.equal(h.created.length, 2);
    assert.equal(h.created[1].connectNumber, PHONE, 'the pairing number must survive the retry');
  });
}

test('watchdog: a QR that arrives after the threshold cannot rescue a runtime that was already stuck (control)', async (t) => {
  mockTimers(t);
  const h = harness();
  await h.service.reconnectInstanceNow(NAME, PHONE);
  const stuck = h.created[0];
  t.mock.timers.tick(PRODUCTION_TIMEOUT_MS);
  await flush();
  stuck.qrCount = 1; // too late: the 20s handshake budget was already spent
  assert.equal(stuck.disposed, true);
});

test('watchdog: a runtime that closed after emitting QRs is not "awaiting pairing" any more', async (t) => {
  mockTimers(t);
  const h = harness();
  await h.service.reconnectInstanceNow(NAME, PHONE);
  const runtime = h.created[0];
  runtime.qrCount = 3;
  t.mock.timers.tick(PRODUCTION_TIMEOUT_MS);
  await flush();
  runtime.stateConnection = { state: 'close' }; // QR refs ended (408): Baileys reports the close itself
  h.service.scheduleReconnect(NAME, runtime, { statusCode: 408 });
  assert.equal(h.attempts(), 1, 'a real close goes through the normal backoff');
  t.mock.timers.tick(5001);
  await flush();
  assert.equal(h.created.length, 2);
  assert.equal(h.created[1].connectNumber, PHONE, 'the new socket must stay in pairing-code mode');
});

test('attempt timeout (same env value): a new runtime that already emitted a QR is kept even if the attempt overruns', async (t) => {
  mockTimers(t);
  const h = harness();
  let release;
  const runtime = makeRuntime('slow-connect');
  runtime.emitQrOnConnect = true; // QR arrives, but connectToWhatsapp() itself (e.g. a wavoip setup) does not return
  runtime.connectGate = new Promise((resolve) => (release = resolve));
  h.prepared.push(runtime);

  const pending = h.service.reconnectInstanceNow(NAME, PHONE);
  await flush();
  assert.equal(runtime.qrCount, 1);
  t.mock.timers.tick(PRODUCTION_TIMEOUT_MS);
  await flush();
  await pending; // must resolve instead of rejecting with ReconnectAttemptTimeoutError
  assert.equal(runtime.disposed, false);
  assert.equal(h.service.waInstances[NAME], runtime);
  assert.equal(h.attempts(), 0);
  assert.equal(h.logs.filter(([level, text]) => level === 'error' && /recreateInstance/.test(JSON.stringify(text))).length, 0);
  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  assert.equal(runtime.disposed, false);
  release();
  await flush();
});

test('attempt timeout (control): an overrunning attempt WITHOUT a QR is still a failed attempt', async (t) => {
  mockTimers(t);
  const h = harness();
  let release;
  const runtime = makeRuntime('slow-connect-no-qr');
  runtime.connectGate = new Promise((resolve) => (release = resolve));
  h.prepared.push(runtime);

  const pending = h.service.reconnectInstanceNow(NAME, PHONE);
  const rejection = assert.rejects(pending, /did not complete within 20000ms/);
  await flush();
  t.mock.timers.tick(PRODUCTION_TIMEOUT_MS);
  await flush();
  await rejection;
  assert.equal(runtime.disposed, true);
  assert.equal(h.attempts(), 1);
  release();
  await flush();
});

test('attempt timeout: the previous (dead) runtime with an old QR count is not mistaken for a pairing wait', async (t) => {
  mockTimers(t);
  const h = harness();
  h.initial.qrCount = 4; // it emitted QRs in an earlier life and has since closed
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  h.prisma.instance.findFirst = async () => {
    await gate; // the attempt hangs before it ever replaces the runtime
    return null;
  };
  const pending = h.service.reconnectInstanceNow(NAME, PHONE);
  const rejection = assert.rejects(pending, /did not complete within 20000ms/);
  await flush();
  t.mock.timers.tick(PRODUCTION_TIMEOUT_MS);
  await flush();
  await rejection;
  assert.equal(h.initial.disposed, true, 'the stuck old runtime is still torn down');
  assert.equal(h.attempts(), 1);
  release();
  await flush();
});

test('isAwaitingPairing: only a live, connecting Baileys runtime that already emitted a QR qualifies', () => {
  const { service } = harness();
  const live = makeRuntime('live');
  live.qrCount = 2;
  assert.equal(service.isAwaitingPairing(live), true);

  const noQr = makeRuntime('no-qr');
  assert.equal(service.isAwaitingPairing(noQr), false);

  const closed = makeRuntime('closed');
  closed.qrCount = 2;
  closed.stateConnection = { state: 'close' };
  assert.equal(service.isAwaitingPairing(closed), false);

  const open = makeRuntime('open');
  open.qrCount = 2;
  open.stateConnection = { state: 'open' };
  assert.equal(service.isAwaitingPairing(open), false);

  const placeholder = service.createReconnectingPlaceholder(NAME, live);
  assert.equal(service.isAwaitingPairing(placeholder), false);

  assert.equal(service.isAwaitingPairing(undefined), false);
  assert.equal(service.isAwaitingPairing({}), false);
  assert.equal(
    service.isAwaitingPairing({
      reconnecting: false,
      connectionStatus: { state: 'connecting' },
      get qrCode() {
        throw new Error('boom');
      },
    }),
    false,
  );
});

test('retries: the pairing number is dropped once the phone accepted the code, and never invented', async (t) => {
  mockTimers(t);
  for (const [label, creds, expected] of [
    ['still waiting', {}, PHONE],
    ['code accepted by the phone (registered)', { registered: true }, undefined],
    ['pair-success received (account)', { account: { details: 'x' } }, undefined],
  ]) {
    const h = harness();
    await h.service.reconnectInstanceNow(NAME, PHONE);
    const runtime = h.created[0];
    runtime.qrCount = 1;
    runtime.instance.authState.state.creds = creds;
    runtime.stateConnection = { state: 'close' };
    h.service.scheduleReconnect(NAME, runtime, { statusCode: 515 });
    t.mock.timers.tick(5001);
    await flush();
    assert.equal(h.created[1].connectNumber, expected, label);
  }

  const noNumber = harness(); // e.g. the manager's "Reiniciar conexión" or a plain QR request
  await noNumber.service.reconnectInstanceNow(NAME);
  const first = noNumber.created[0];
  first.stateConnection = { state: 'close' };
  noNumber.service.scheduleReconnect(NAME, first, { statusCode: 428 });
  t.mock.timers.tick(5001);
  await flush();
  assert.equal(noNumber.created[1].connectNumber, undefined);
});

test('a fresh reconnectInstanceNow without a number forgets the previous pairing number', async (t) => {
  mockTimers(t);
  const h = harness();
  await h.service.reconnectInstanceNow(NAME, PHONE);
  assert.equal(h.service.reconnectStates.get(NAME).number, PHONE);
  await h.service.reconnectInstanceNow(NAME);
  assert.equal(h.service.reconnectStates.get(NAME).number, undefined);
});
