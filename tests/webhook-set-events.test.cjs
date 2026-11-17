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
    ...globals,
  });
  return module.exports;
}

const { EventController } = load('src/api/integrations/event/event.controller.ts');
class Logger {
  log() {}
  error() {}
}
const { WebhookController } = load(
  'src/api/integrations/event/webhook/webhook.controller.ts',
  {
    axios: { __esModule: true, default: { create: () => ({ post: async () => {} }) } },
    crypto: { createHash: crypto.createHash },
    jsonwebtoken: {},
    '@config/env.config': { configService: { get: () => ({}) } },
    '@config/logger.config': { Logger },
    '../event.controller': { EventController },
  },
  { Error },
);

// A stateful stand-in for the Webhook table: what /webhook/set stores is what /webhook/find returns.
function controller() {
  let row = null;
  const db = {
    webhook: {
      upsert: async ({ create, update }) => (row = { ...(row ?? create), ...(row ? update : {}) }),
    },
  };
  const monitor = { waInstances: { own: { instanceId: 'own-id' } } };
  return { ctl: new WebhookController(db, monitor), saved: () => row };
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const body = (webhook) => ({ webhook: { url: 'https://n8n.example/webhook/abc', ...webhook } });

test('a webhook saved while disabled keeps the events that were selected', async () => {
  const { ctl, saved } = controller();
  await ctl.set('own', body({ enabled: false, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'] }));
  assert.equal(saved().enabled, false);
  assert.deepEqual(plain(saved().events), ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
});

test('disabling and re-enabling a webhook does not change its event subscription', async () => {
  const { ctl, saved } = controller();
  await ctl.set('own', body({ enabled: true, events: ['MESSAGES_UPSERT'] }));
  await ctl.set('own', body({ enabled: false, events: ['MESSAGES_UPSERT'] }));
  assert.deepEqual(plain(saved().events), ['MESSAGES_UPSERT']);
  await ctl.set('own', body({ enabled: true, events: saved().events }));
  assert.deepEqual(plain(saved().events), ['MESSAGES_UPSERT']);
});

test('an enabled webhook stores exactly the events it was given', async () => {
  const { ctl, saved } = controller();
  await ctl.set('own', body({ enabled: true, events: ['MESSAGES_UPSERT'] }));
  assert.deepEqual(plain(saved().events), ['MESSAGES_UPSERT']);
});

test('an enabled webhook with an empty event list still subscribes to every event', async () => {
  const { ctl, saved } = controller();
  await ctl.set('own', body({ enabled: true, events: [] }));
  assert.deepEqual(plain(saved().events), plain(EventController.events));
});

test('a request without an events property is handled instead of throwing', async () => {
  const { ctl, saved } = controller();
  await ctl.set('own', body({ enabled: true }));
  assert.deepEqual(plain(saved().events), plain(EventController.events));
  await ctl.set('own', body({ enabled: false }));
  assert.deepEqual(plain(saved().events), []);
});
