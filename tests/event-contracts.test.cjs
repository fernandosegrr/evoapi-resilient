const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { validate } = require('jsonschema');

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
const plain = (value) => JSON.parse(JSON.stringify(value));

test('find preserves the legacy disabled/absent contract and offers explicit status on request', async () => {
  const monitor = { waInstances: { own: { instanceId: 'own-id' } } };
  const db = {
    sqs: {
      findUnique: async ({ where }) => {
        assert.equal(where.instanceId, 'own-id');
        return null;
      },
    },
  };
  const disabled = new EventController(db, monitor, false, 'sqs');
  assert.equal(await disabled.get('own'), undefined);
  assert.equal(await disabled.find('own'), undefined);
  assert.deepEqual(plain(await disabled.find('own', true)), {
    enabled: false,
    events: [],
    globalEnabled: false,
    globalModeEnabled: false,
  });
  const enabled = new EventController(db, monitor, true, 'sqs');
  assert.equal(await enabled.get('own'), null);
  assert.equal(await enabled.find('own'), null);
  assert.equal((await enabled.find('own', true)).globalEnabled, true);
});

test('find enriches saved records without mutating them or changing internal get()', async () => {
  const record = { id: 'row', instanceId: 'own-id', enabled: true, events: ['GROUP_UPDATE'] };
  const db = {
    webhook: {
      findUnique: async ({ where }) => {
        assert.equal(where.instanceId, 'own-id');
        return record;
      },
    },
  };
  const controller = new EventController(db, { waInstances: { own: { instanceId: 'own-id' } } }, true, 'webhook');
  assert.equal(await controller.get('own'), record);
  assert.deepEqual(plain(await controller.find('own')), { ...record, globalEnabled: true, globalModeEnabled: false });
  assert.equal('globalEnabled' in record, false);
});

test('group wire names map to the real canonical list without changing any other event ID', () => {
  for (const event of ['groups.update', 'groups-update', 'GROUPS_UPDATE', 'group.update', 'GROUP_UPDATE']) {
    assert.equal(EventController.eventKey(event), 'GROUP_UPDATE');
    assert.ok(EventController.events.includes(EventController.eventKey(event)));
  }
  for (const event of EventController.events) assert.equal(EventController.eventKey(event), event);
  const source = ts.createSourceFile(
    'wa.types.ts',
    fs.readFileSync(path.join(root, 'src/api/types/wa.types.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const enumNode = source.statements.find((node) => ts.isEnumDeclaration(node) && node.name.text === 'Events');
  const wire = enumNode.members.find((member) => member.name.getText(source) === 'GROUPS_UPDATE').initializer.text;
  assert.equal(wire, 'groups.update');
  assert.ok(EventController.events.includes(EventController.eventKey(wire)));
});

const prefixes = {
  SQS: 'SQS_GLOBAL',
  RABBITMQ: 'RABBITMQ_EVENTS',
  NATS: 'NATS_EVENTS',
  KAFKA: 'KAFKA_EVENTS',
  PUSHER: 'PUSHER_EVENTS',
  WEBHOOK: 'WEBHOOK_EVENTS',
};
for (const [service, prefix] of Object.entries(prefixes)) {
  test(`${service} accepts canonical environment flag, retains old alias and honors explicit false`, () => {
    const read = (env) =>
      load(
        'src/config/env.config.ts',
        {
          dotenv: { config() {} },
          'class-validator': { isBooleanString: (value) => ['true', 'false'].includes(value) },
        },
        { process: { env: { DATABASE_PROVIDER: 'postgresql', ...env } } },
      ).configService.get(service).EVENTS;
    assert.equal(read({ [`${prefix}_GROUP_UPDATE`]: 'true' }).GROUP_UPDATE, true);
    assert.equal(read({ [`${prefix}_GROUPS_UPDATE`]: 'true' }).GROUP_UPDATE, true);
    const canonicalWins = read({ [`${prefix}_GROUP_UPDATE`]: 'false', [`${prefix}_GROUPS_UPDATE`]: 'true' });
    assert.equal(canonicalWins.GROUP_UPDATE, false);
    assert.equal('GROUPS_UPDATE' in canonicalWins, false);
  });
}

const { sqsSchema } = load('src/api/integrations/event/sqs/sqs.schema.ts', {
  uuid: { v4: () => 'sqs-test' },
  '../event.controller': { EventController },
});
for (const value of [
  {},
  { enabled: true, events: [] },
  { sqs: {} },
  { sqs: { enabled: true } },
  { sqs: { enabled: false } },
  { sqs: { events: [] } },
  { sqs: null },
  { sqs: { enabled: 'true', events: [] } },
  { sqs: { enabled: true, events: ['GROUPS_UPDATE'] } },
]) {
  test(`SQS schema rejects unsupported controller input: ${JSON.stringify(value)}`, () => {
    const result = validate(value, plain(sqsSchema));
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });
}
test('SQS schema accepts explicit empty events, canonical events and enabled false', () => {
  for (const enabled of [true, false])
    for (const events of [[], [...EventController.events]]) {
      assert.equal(validate({ sqs: { enabled, events } }, plain(sqsSchema)).valid, true);
    }
});

test('proxy test bounds both Axios calls and shares cancellation with the raw proxy agent', async () => {
  const calls = [];
  const state = { destroyed: false, signal: undefined, scheduled: undefined, cleared: false };
  const axios = {
    get: async (url, options) => {
      calls.push({ url, options });
      return { data: calls.length === 1 ? 'origin-ip' : 'proxy-ip' };
    },
    isAxiosError: () => false,
  };
  const { ProxyController } = load(
    'src/api/controllers/proxy.controller.ts',
    {
      axios,
      '@config/logger.config': {
        Logger: class {
          info() {}
          warn() {}
          error() {}
        },
      },
      '@exceptions': { BadRequestException: Error, NotFoundException: Error },
      '@utils/makeProxyAgent': {
        makeProxyAgent: (_proxy, signal) => {
          state.signal = signal;
          return {
            destroy: () => {
              state.destroyed = true;
            },
          };
        },
      },
    },
    {
      AbortController,
      setTimeout: (_fn, ms) => {
        state.scheduled = ms;
        return 1;
      },
      clearTimeout: () => {
        state.cleared = true;
      },
    },
  );
  assert.equal(await new ProxyController({}, {}).testProxy({ host: 'test', port: '1', protocol: 'http' }), true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.timeout, 10000);
    assert.equal(call.options.signal, state.signal);
  }
  assert.equal(state.scheduled, 10000);
  assert.equal(state.destroyed, true);
  assert.equal(state.cleared, true);
  assert.equal(state.signal.aborted, true);
});
