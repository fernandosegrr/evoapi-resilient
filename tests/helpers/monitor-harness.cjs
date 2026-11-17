// The real WAMonitoringService with fake collaborators (Prisma, the channel factory, Baileys runtimes), shared by the
// tests that exercise how the monitor and the link service use it. Timers are whatever the calling test has mocked.
const { loadTs } = require('./ts-loader.cjs');
const { afterEach } = require('node:test');

// Every harness arms real watchdog/backoff timers; cancel them when a test ends so they cannot keep retrying in the background.
const openHarnesses = [];
afterEach(() => {
  for (const harness of openHarnesses.splice(0)) harness.service.cancelReconnect(harness.name);
});

const state = { factory: null, logs: null };
class FakeLogger {
  info(message) {
    state.logs?.push(['info', message]);
  }
  warn(message) {
    state.logs?.push(['warn', message]);
  }
  error(message) {
    state.logs?.push(['error', message]);
  }
  log(message) {
    state.logs?.push(['log', message]);
  }
}
class HttpError extends Error {}

const { ConfigService } = loadTs('src/config/env.config.ts', { dotenv: { config() {} } });
const monitorModule = loadTs('src/api/services/monitor.service.ts', {
  '@api/server.module': { channelController: { init: (data) => state.factory(data) } },
  '@api/types/wa.types': {
    Events: new Proxy({}, { get: (_target, key) => String(key) }),
    Integration: { WHATSAPP_BAILEYS: 'WHATSAPP-BAILEYS' },
  },
  '@config/logger.config': { Logger: FakeLogger },
  '@config/path.config': { INSTANCE_DIR: '/tmp/instances', STORE_DIR: '/tmp/store' },
  '@exceptions': { BadRequestException: HttpError, NotFoundException: HttpError },
  eventemitter2: { default: class {} },
});

const NAME = 'link-test';
const INSTANCE_ID = 'instance-1';

// What Baileys' ChannelStartupService exposes to the monitor. qrCount mirrors instance.qrcode.count, bumped on every
// `qr` event; creds is the in-memory credentials object Baileys updates in place.
function makeRuntime(label, overrides = {}) {
  return {
    label,
    instanceId: INSTANCE_ID,
    integration: 'WHATSAPP-BAILEYS',
    disposed: false,
    disposeReason: undefined,
    loggedOut: false,
    connectCalls: 0,
    connectNumber: undefined,
    qrCount: 0,
    pairingCode: null,
    base64: null,
    stateConnection: { state: 'connecting' },
    localProxy: { enabled: false },
    instance: { authState: { state: { creds: {} } } },
    get connectionStatus() {
      return this.stateConnection;
    },
    get qrCode() {
      return { count: this.qrCount, pairingCode: this.pairingCode, base64: this.base64, code: 'RAW-QR-STRING' };
    },
    setInstance(data) {
      this.instanceName = data.instanceName;
    },
    async connectToWhatsapp(number) {
      this.connectCalls++;
      this.connectNumber = number;
      state.events?.push(`connect:${this.label}`);
    },
    async disposeConnection(reason) {
      this.disposed = true;
      this.disposeReason = reason;
      state.events?.push(`dispose:${this.label}`);
    },
    async logoutInstance() {
      this.loggedOut = true;
    },
    async sendDataWebhook() {},
    ...overrides,
  };
}

function createHarness({ env = {}, runtimeOverrides = {}, initialState = 'close' } = {}) {
  const defaults = {
    WA_RECONNECT_ATTEMPT_TIMEOUT_MS: '20000',
    WA_RECONNECT_JITTER_FACTOR: '0.0001',
    DATABASE_SAVE_DATA_INSTANCE: 'true',
    CACHE_REDIS_ENABLED: 'false',
    CACHE_REDIS_SAVE_INSTANCES: 'false',
    PROVIDER_ENABLED: 'false',
  };
  const applied = { ...defaults, ...env };
  const saved = Object.fromEntries(Object.keys(applied).map((key) => [key, process.env[key]]));
  Object.assign(process.env, applied);
  let configService;
  try {
    configService = new ConfigService();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const logs = [];
  const events = [];
  const created = [];
  const prepared = [];
  state.logs = logs;
  state.events = events;
  state.factory = () => {
    const runtime = prepared.shift() ?? makeRuntime(`runtime-${created.length + 1}`, runtimeOverrides);
    created.push(runtime);
    return runtime;
  };

  const stored = { id: INSTANCE_ID, name: NAME, integration: 'WHATSAPP-BAILEYS', token: 'token', number: null, businessId: null, ownerJid: null };
  const sessions = new Map();
  const prisma = {
    instance: {
      findFirst: async () => stored,
      update: async () => stored,
      updateMany: async () => ({ count: 1 }),
    },
    session: {
      findUnique: async ({ where }) => (sessions.has(where.sessionId) ? { sessionId: where.sessionId, creds: sessions.get(where.sessionId) } : null),
    },
  };
  const service = new monitorModule.WAMonitoringService({ on() {} }, configService, prisma, null, null, null, null);
  service.cleaningUp = async (name, id) => {
    events.push(`clean:${name}:${id}`);
  };

  const initial = makeRuntime('initial', runtimeOverrides);
  initial.stateConnection = { state: initialState };
  service.registerNewInstanceRuntime(NAME, initial);

  const harness = {
    service,
    initial,
    created,
    prepared,
    logs,
    events,
    prisma,
    sessions,
    stored,
    makeRuntime,
    configService,
    name: NAME,
  };
  openHarnesses.push(harness);
  return harness;
}

const flush = async (rounds = 12) => {
  for (let index = 0; index < rounds; index++) await new Promise((resolve) => setImmediate(resolve));
};

module.exports = { createHarness, makeRuntime, flush, monitorModule, NAME, INSTANCE_ID };
