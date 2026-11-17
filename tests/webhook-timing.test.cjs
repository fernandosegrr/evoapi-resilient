const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

function load(relative, dependencies = {}, globals = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require(name) {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
    setTimeout,
    clearTimeout,
    Date,
    URL,
    ...globals,
  });
  return module.exports;
}

const { EventController } = load('src/api/integrations/event/event.controller.ts');

function webhookController() {
  const posts = [];
  const config = {
    WEBHOOK: {
      GLOBAL: { ENABLED: false },
      EVENTS: {},
      REQUEST: { TIMEOUT_MS: 30000 },
      RETRY: { MAX_ATTEMPTS: 1, INITIAL_DELAY_SECONDS: 1, USE_EXPONENTIAL_BACKOFF: false, MAX_DELAY_SECONDS: 1 },
    },
    LOG: { LEVEL: [] },
  };
  class Logger {
    log() {}
    error() {}
  }
  const { WebhookController } = load(
    'src/api/integrations/event/webhook/webhook.controller.ts',
    {
      axios: {
        __esModule: true,
        default: {
          create: (options) => ({
            post: async (url, body) => {
              posts.push({ url, body, headers: options.headers, baseURL: options.baseURL });
            },
          }),
        },
      },
      crypto: { createHash: crypto.createHash },
      jsonwebtoken: {},
      '@config/env.config': { configService: { get: (key) => config[key] } },
      '@config/logger.config': { Logger },
      '../event.controller': { EventController },
    },
    { Error },
  );
  return { controller: new WebhookController({}, {}), posts };
}

const snapshot = { enabled: true, url: 'https://n8n.example/webhook/abc', events: ['MESSAGES_UPSERT'], webhookByEvents: false };
const emitUpsert = (controller, overrides = {}) =>
  controller.emit({
    instanceName: 'example-instance',
    origin: 'test',
    event: 'messages.upsert',
    data: { key: { id: 'ABC123', remoteJid: '5214620000001@s.whatsapp.net', fromMe: false }, messageType: 'conversation' },
    serverUrl: 'https://evo.example',
    dateTime: '2026-10-06T14:33:05.000Z',
    sender: '5214620000002@s.whatsapp.net',
    local: true,
    webhookDelivery: { webhookSnapshot: snapshot },
    ...overrides,
  });

test('the three timing fields travel at the top level of the message webhook, next to date_time', async () => {
  const { controller, posts } = webhookController();
  const extra = { receivedAtMs: 1_790_000_000_000, enqueuedAtMs: 1_790_000_000_020, dispatchedAtMs: 1_790_000_000_450 };

  await emitUpsert(controller, { extra });

  assert.equal(posts.length, 1);
  const { body } = posts[0];
  assert.equal(body.receivedAtMs, extra.receivedAtMs);
  assert.equal(body.enqueuedAtMs, extra.enqueuedAtMs);
  assert.equal(body.dispatchedAtMs, extra.dispatchedAtMs);
  assert.ok(Number.isInteger(body.dispatchedAtMs) && body.dispatchedAtMs - body.receivedAtMs === 450);
});

test('date_time and the message itself are left exactly as they were', async () => {
  const { controller, posts } = webhookController();
  await emitUpsert(controller, { extra: { receivedAtMs: 1, enqueuedAtMs: 2, dispatchedAtMs: 3 } });

  const { body } = posts[0];
  assert.equal(body.date_time, '2026-10-06T14:33:05.000Z');
  assert.equal(body.event, 'messages.upsert');
  assert.equal(body.instance, 'example-instance');
  assert.deepEqual(Object.keys(body.data).sort(), ['key', 'messageType']);
  assert.equal(JSON.stringify(body.data).includes('AtMs'), false, 'nothing is added inside data');
});

test('a webhook without timing extras is unchanged, and the extras can never override the core fields', async () => {
  const plain = webhookController();
  await emitUpsert(plain.controller);
  for (const field of ['receivedAtMs', 'enqueuedAtMs', 'dispatchedAtMs']) assert.equal(field in plain.posts[0].body, false);

  const hostile = webhookController();
  await emitUpsert(hostile.controller, { extra: { event: 'spoofed', instance: 'spoofed', date_time: 'spoofed', data: 'spoofed' } });
  assert.equal(hostile.posts[0].body.event, 'messages.upsert');
  assert.equal(hostile.posts[0].body.instance, 'example-instance');
  assert.equal(hostile.posts[0].body.date_time, '2026-10-06T14:33:05.000Z');
  assert.equal(typeof hostile.posts[0].body.data, 'object');
});

test('the Idempotency-Key of an event does not change with the timing fields', async () => {
  const first = webhookController();
  await emitUpsert(first.controller, { extra: { receivedAtMs: 1, enqueuedAtMs: 2, dispatchedAtMs: 3 } });
  const retry = webhookController();
  await emitUpsert(retry.controller, { extra: { receivedAtMs: 1, enqueuedAtMs: 2, dispatchedAtMs: 99_999 } });

  assert.match(first.posts[0].headers['Idempotency-Key'], /^evolution-[0-9a-f]{64}$/);
  assert.equal(first.posts[0].headers['Idempotency-Key'], retry.posts[0].headers['Idempotency-Key']);
});

// The service needs a live Baileys socket, so where the timestamps are taken is pinned structurally.
const serviceSource = fs.readFileSync(
  path.join(root, 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'),
  'utf8',
);

test('dispatchedAtMs is taken when the webhook leaves the queue, not when it is queued', () => {
  const start = serviceSource.indexOf('private enqueueMessageWebhook(');
  const method = serviceSource.slice(start, serviceSource.indexOf('private async claimIncomingMessage'));

  const stampedAtEnqueue = method.indexOf('const enqueuedAtMs = Date.now()');
  const queueCall = method.indexOf('this.messageWebhookQueue');
  const stampedAtDispatch = method.indexOf('const dispatchedAtMs = Date.now()');

  assert.ok(stampedAtEnqueue > 0 && queueCall > stampedAtEnqueue, 'enqueuedAtMs is taken before queueing');
  assert.ok(stampedAtDispatch > queueCall, 'dispatchedAtMs is evaluated inside the queued task');
  assert.match(method, /receivedAtMs: receivedAtMs \?\? enqueuedAtMs/);
});

test('receivedAtMs is taken as soon as Baileys hands the events over, before they wait in the chain', () => {
  const start = serviceSource.indexOf('this.client.ev.process(async (events) => {');
  const block = serviceSource.slice(start, start + 600);

  assert.ok(block.indexOf('const receivedAtMs = Date.now()') > 0);
  assert.ok(block.indexOf('const receivedAtMs = Date.now()') < block.indexOf('this.eventQueue.enqueue('));
  assert.match(serviceSource, /this\.messageHandle\['messages\.upsert'\]\(\{ \.\.\.payload, receivedAtMs \}, settings\)/);
  assert.equal((serviceSource.match(/this\.enqueueMessageWebhook\(createWebhookMessage\(\), receivedAtMs\)/g) ?? []).length, 2);
});

test('date_time keeps its (non-UTC) computation and is documented as such', () => {
  const channel = fs.readFileSync(path.join(root, 'src/api/services/channel.service.ts'), 'utf8');
  assert.match(channel, /const localISOTime = new Date\(Date\.now\(\) - tzoffset\)\.toISOString\(\);/);
  assert.match(channel, /date_time is the server's local wall-clock time labelled with a trailing "Z", NOT UTC/);
});
