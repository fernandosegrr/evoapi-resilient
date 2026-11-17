const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const express = require(path.join(root, 'node_modules/express'));

function load(relative, dependencies = {}) {
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
    Buffer,
  });
  return module.exports;
}

const metricsModule = load('src/utils/deliveryMetrics.ts', { crypto: require('node:crypto') });
const { SerialQueue } = load('src/utils/serialQueue.ts');
const { createDeliveryMetricsRouter } = load('src/api/routes/deliveryMetrics.router.ts', {
  '@utils/deliveryMetrics': metricsModule,
  express: { Router: express.Router },
});
const { InstanceDeliveryMetrics, DeliveryMetricsRegistry, MessageTimeline, abbreviateJid } = metricsModule;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PHONE = '5214620000001@s.whatsapp.net';
const plain = (value) => JSON.parse(JSON.stringify(value));

function clock(start = 1_790_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => void (now += ms) };
}

test('chats are abbreviated with a keyed hash: stable, distinguishable and never the number', () => {
  const first = abbreviateJid(PHONE);
  assert.match(first, /^pn:[0-9a-f]{8}$/);
  assert.equal(abbreviateJid(PHONE), first);
  assert.notEqual(abbreviateJid('5214620000002@s.whatsapp.net'), first);
  assert.equal(first.includes('5214620000001'), false);

  assert.match(abbreviateJid('120363000000000001@g.us'), /^group:[0-9a-f]{8}$/);
  assert.match(abbreviateJid('88800001111@lid'), /^lid:[0-9a-f]{8}$/);
  assert.equal(abbreviateJid('status@broadcast'), 'status');
  assert.equal(abbreviateJid(''), undefined);
  assert.equal(abbreviateJid(null), undefined);
  assert.equal(abbreviateJid(12345), undefined);
});

test('only steps that reach 2 seconds are kept, and the boundary counts as slow', () => {
  const metrics = new InstanceDeliveryMetrics('example-instance');

  assert.equal(metrics.recordStep('claim', 1_999, PHONE), false);
  assert.equal(metrics.recordStep('claim', 2_000, PHONE), true);
  assert.equal(metrics.recordStep('profile.picture', 5_012.6, PHONE), true);
  for (const junk of [NaN, -5, undefined, Infinity * 0]) assert.equal(metrics.recordStep('x', junk), false);

  const { slowSteps } = plain(metrics.snapshot());
  assert.equal(slowSteps.thresholdMs, 2_000);
  assert.equal(slowSteps.totalSinceStart, 2);
  assert.deepEqual(
    slowSteps.recent.map((entry) => [entry.step, entry.durationMs]),
    [
      ['profile.picture', 5_013],
      ['claim', 2_000],
    ],
    'newest first',
  );
});

test('the slow-step buffer is circular: it keeps the latest 50 and still counts every one', () => {
  const metrics = new InstanceDeliveryMetrics('i');
  for (let n = 1; n <= 120; n++) metrics.recordStep(`step-${n}`, 2_000 + n);

  const { slowSteps } = plain(metrics.snapshot());
  assert.equal(slowSteps.totalSinceStart, 120);
  assert.equal(slowSteps.recent.length, 50);
  assert.equal(slowSteps.recent[0].step, 'step-120');
  assert.equal(slowSteps.recent[49].step, 'step-71');
});

test('slow steps expose only step, duration, time and an abbreviated chat: no number, no text', () => {
  const metrics = new InstanceDeliveryMetrics('i');
  metrics.recordStep('contact.write', 3_000, PHONE);

  const entry = plain(metrics.snapshot()).slowSteps.recent[0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'chat', 'durationMs', 'step']);
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(JSON.stringify(metrics.snapshot()).includes('5214620000001'), false);
});

test('the longest queue wait covers the last 15 minutes and then fades out', () => {
  const time = clock();
  const metrics = new InstanceDeliveryMetrics('i', time.now);

  metrics.recordEventQueueWait(61_000);
  metrics.recordWebhookQueueWait(120);
  time.advance(5 * 60_000);
  metrics.recordEventQueueWait(2_000);

  assert.equal(metrics.snapshot().eventQueue.maxWaitMsLast15m, 61_000);
  assert.equal(metrics.snapshot().webhookQueue.maxWaitMsLast15m, 120);

  time.advance(9 * 60_000);
  assert.equal(metrics.snapshot().eventQueue.maxWaitMsLast15m, 61_000, 'still inside the window 14 minutes later');

  // the window has one-minute resolution, so give it a full bucket beyond 15 minutes
  time.advance(2.5 * 60_000);
  assert.equal(metrics.snapshot().eventQueue.maxWaitMsLast15m, 2_000, 'the 61s wait is older than 15 minutes');

  time.advance(15 * 60_000);
  assert.equal(metrics.snapshot().eventQueue.maxWaitMsLast15m, 0);
  assert.equal(metrics.snapshot().webhookQueue.maxWaitMsLast15m, 0);
});

test('a probe that throws never breaks the snapshot', () => {
  const metrics = new InstanceDeliveryMetrics('i');
  metrics.attach({
    eventQueueDepth: () => {
      throw new Error('boom');
    },
    webhookQueueDepth: () => 4,
    profilePictures: () => {
      throw new Error('boom');
    },
  });

  const snapshot = plain(metrics.snapshot());
  assert.equal(snapshot.eventQueue.depth, 0);
  assert.equal(snapshot.webhookQueue.depth, 4);
  assert.deepEqual(snapshot.profilePictures, { active: 0, queued: 0, cached: 0 });
});

test('the registry keeps one record per instance', () => {
  const registry = new DeliveryMetricsRegistry();
  assert.equal(registry.forInstance('a'), registry.forInstance('a'));
  registry.forInstance('b');
  assert.deepEqual(plain(registry.snapshotAll()).map((s) => s.instanceName).sort(), ['a', 'b']);
});

test('a message timeline adds up repeated steps and reports the chat abbreviated', () => {
  const time = clock();
  const timeline = new MessageTimeline('ABC123', PHONE, false, time.now() - 800, time.now);
  timeline.add('claim', 12);
  timeline.add('claim', 8);
  timeline.add('contact.write', 30);
  time.advance(250);

  const summary = plain(timeline.summary());
  assert.deepEqual(summary.steps, { claim: 20, 'contact.write': 30 });
  assert.equal(summary.delayBeforeHandlingMs, 800);
  assert.equal(summary.handlingMs, 250);
  assert.match(summary.chat, /^pn:/);
  assert.equal(JSON.stringify(summary).includes('5214620000001'), false);
});

// ---- the HTTP endpoint, for real -------------------------------------------------------------------------

async function withServer(registry, run) {
  const apikey = (expected) => (req, res, next) =>
    expected.includes(req.get('apikey')) ? next() : res.status(401).json({ message: 'Unauthorized' });
  const app = express();
  app.use(
    '/instance',
    createDeliveryMetricsRouter(registry, { all: [apikey(['global'])], one: [apikey(['global', 'token-example'])] }),
  );
  const server = http.createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}/instance/deliveryMetrics`;
  try {
    return await run((suffix = '', key) => fetch(base + suffix, { headers: key ? { apikey: key } : {} }));
  } finally {
    await new Promise((done) => server.close(done));
  }
}

test('the endpoint requires an API key and answers with coherent data after a slow step', async () => {
  const registry = new DeliveryMetricsRegistry();
  const metrics = registry.forInstance('example-instance');

  // the same wiring the service uses: the queues report their waits and expose their depth
  const eventQueue = new SerialQueue({ onWait: (ms) => metrics.recordEventQueueWait(ms) });
  const webhookQueue = new SerialQueue({ onWait: (ms) => metrics.recordWebhookQueueWait(ms) });
  metrics.attach({
    eventQueueDepth: () => eventQueue.depth,
    webhookQueueDepth: () => webhookQueue.depth,
    profilePictures: () => ({ active: 1, queued: 3, cached: 40 }),
  });

  // a slow message holds the chain while two more events queue behind it
  let releaseSlowMessage;
  const slowMessage = eventQueue.enqueue(
    () =>
      new Promise((done) => {
        releaseSlowMessage = done;
      }),
  );
  const behind = [eventQueue.enqueue(() => 'second'), eventQueue.enqueue(() => 'third')];
  await sleep(5);
  metrics.recordStep('profile.picture', 5_000, PHONE);

  await withServer(registry, async (get) => {
    assert.equal((await get('', undefined)).status, 401);
    assert.equal((await get('/example-instance', undefined)).status, 401);
    assert.equal((await get('', 'token-example')).status, 401, 'an instance key cannot list every instance');

    const one = await (await get('/example-instance', 'token-example')).json();
    assert.equal(one.instanceName, 'example-instance');
    assert.equal(one.eventQueue.depth, 3, 'one running plus two waiting');
    assert.equal(one.webhookQueue.depth, 0);
    assert.deepEqual(one.profilePictures, { active: 1, queued: 3, cached: 40 });
    assert.equal(one.slowSteps.totalSinceStart, 1);
    assert.equal(one.slowSteps.recent[0].step, 'profile.picture');
    assert.equal(one.slowSteps.recent[0].durationMs, 5_000);
    assert.match(one.slowSteps.recent[0].chat, /^pn:[0-9a-f]{8}$/);
    assert.equal(JSON.stringify(one).includes('5214620000001'), false);
    assert.equal(one.windowMinutes, 15);

    await sleep(60);
    releaseSlowMessage();
    await Promise.all([slowMessage, ...behind]);

    const afterwards = await (await get('/example-instance', 'global')).json();
    assert.equal(afterwards.eventQueue.depth, 0);
    assert.ok(afterwards.eventQueue.maxWaitMsLast15m >= 50, `the queued events waited (${afterwards.eventQueue.maxWaitMsLast15m}ms)`);

    const all = await (await get('', 'global')).json();
    assert.match(all.generatedAt, /Z$/);
    assert.deepEqual(all.instances.map((instance) => instance.instanceName), ['example-instance']);
  });
});

// ---- wiring in the service and router (they need a live Baileys socket / the whole server) ---------------

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const serviceSource = read('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts');

test('the endpoint is mounted with the global key only for the all-instances view', () => {
  const router = read('src/api/routes/instance.router.ts');
  assert.match(router, /createDeliveryMetricsRouter\(deliveryMetrics, \{ all: \[authGuard\['apikey'\]\], one: guards \}\)/);
});

test('[SLOW-STEP] is emitted from a single place, as one WARN with instance, step and duration', () => {
  const warnings = serviceSource.match(/logger\.warn\(`\[SLOW-STEP\]/g) ?? [];
  assert.equal(warnings.length, 1);
  assert.match(serviceSource, /this\.logger\.warn\(`\[SLOW-STEP\] instance=\$\{this\.instanceName\} step=\$\{step\} durationMs=/);
});

test('WEBHOOK_TIMING_LOGS defaults to off, is documented, and guards every [WEBHOOK-TIMING] line', () => {
  assert.match(read('src/config/env.config.ts'), /TIMING_LOGS: process\.env\?\.WEBHOOK_TIMING_LOGS === 'true'/);
  assert.match(read('.env.example'), /^WEBHOOK_TIMING_LOGS=false$/m);

  const logMessage = serviceSource.slice(serviceSource.indexOf('private logMessageTimeline('), serviceSource.indexOf('private logMessageTimeline(') + 200);
  assert.match(logMessage, /if \(!this\.timingLogsEnabled\) return;/);

  const delivery = serviceSource.indexOf('[WEBHOOK-TIMING] delivery');
  assert.ok(serviceSource.lastIndexOf('if (this.timingLogsEnabled)', delivery) > serviceSource.lastIndexOf('}', delivery - 300) - 400);
  assert.equal((serviceSource.match(/\[WEBHOOK-TIMING\]/g) ?? []).length, 2);
});

test('both queues report their waits and the metrics are attached when the connection starts', () => {
  assert.match(serviceSource, /new SerialQueue\(\{ onWait: \(waitMs\) => this\.metrics\.recordEventQueueWait\(waitMs\) \}\)/);
  assert.match(serviceSource, /onWait: \(waitMs\) => this\.metrics\.recordWebhookQueueWait\(waitMs\)/);
  assert.match(serviceSource, /this\.metrics\.attach\(\{\s+eventQueueDepth: \(\) => this\.eventQueue\.depth,\s+webhookQueueDepth: \(\) => this\.messageWebhookQueue\.depth/);
});
