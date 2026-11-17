const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const { versionHarness, declaration, fresh } = require('./helpers/wa-version-harness.cjs');

test('shares concurrent dynamic lookups and caches only a validated remote version for 24 hours', async () => {
  let resolve;
  const helper = versionHarness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const first = helper.lookup();
  const second = helper.lookup();
  await helper.settle();
  assert.equal(helper.calls(), 1);
  resolve(declaration(fresh));
  const results = await Promise.all([first, second]);
  results[0].version[2] = 0;
  assert.equal(results[1].version.join('.'), fresh.join('.'));
  helper.advance(24 * 60 * 60 * 1000 - 1);
  assert.equal((await helper.lookup()).version.join('.'), fresh.join('.'));
  assert.equal(helper.calls(), 1);
  helper.advance(1);
  await helper.lookup();
  assert.equal(helper.calls(), 2);
  resolve(declaration([2, 3000, 1234567891]));
  await helper.settle();
  assert.equal((await helper.lookup()).version[2], 1234567891);
  assert.ok(helper.agents.every((agent) => agent.destroyed));
});
test('never treats a static fallback response as a fresh lookup and retries after cooldown', async () => {
  let available = false;
  const helper = versionHarness(async () =>
    available ? declaration(fresh) : JSON.stringify({ version: [2, 3000, 1], isLatest: false }),
  );
  const fallback = await helper.lookup();
  assert.equal(fallback.isLatest, false);
  assert.equal(fallback.source, 'bundled');
  assert.equal(helper.files.size, 0);
  available = true;
  helper.advance(30_000);
  assert.equal((await helper.lookup()).isLatest, true);
  assert.equal(helper.calls(), 2);
});
test('serves a bounded last-good version after failed refresh and never marks it fresh', async () => {
  let available = true;
  const helper = versionHarness(async () => {
    if (!available) throw Error('offline');
    return declaration(fresh);
  });
  await helper.lookup();
  helper.advance(24 * 60 * 60 * 1000);
  available = false;
  const result = await helper.lookup();
  await helper.settle();
  assert.equal(result.version.join('.'), fresh.join('.'));
  assert.equal(result.source, 'last-good');
  assert.equal(result.isLatest, false);
  assert.equal(result.ageMs, 24 * 60 * 60 * 1000);
  helper.advance(7 * 24 * 60 * 60 * 1000);
  assert.equal((await helper.lookup()).source, 'bundled');
});
test('bounds the total deadline, destroys transport and never caches a late response', async () => {
  let resolve;
  const helper = versionHarness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const result = await helper.lookup({ timeout: 10 });
  assert.equal(result.source, 'bundled');
  assert.equal(helper.agents[0].destroyed, true);
  resolve(declaration(fresh));
  await helper.settle();
  assert.equal(helper.files.size, 0);
  assert.equal(helper.getWaVersionTelemetry().refreshSuccess, 0);
});
test('caps transport timeout at 15 seconds and rejects malformed version data', async () => {
  const helper = versionHarness(async () => 'const version = [2, -1, 4];');
  assert.equal((await helper.lookup({ timeout: 60000 })).source, 'bundled');
  assert.equal(helper.agents[0].options.connect.timeout, 15000);
});

// Execute the actual cleanup method in isolation: importing the service normally bootstraps integrations.
const monitorPath = path.join(root, 'src/api/services/monitor.service.ts');
const monitorSource = ts.createSourceFile(
  monitorPath,
  fs.readFileSync(monitorPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const monitorClass = monitorSource.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name.text === 'WAMonitoringService',
);
const cleanup = monitorClass.members.find((node) => node.name?.getText(monitorSource) === 'cleaningUp');
const { outputText: cleanupCode } = ts.transpileModule(
  `class CleanupSubject { ${cleanup.getText(monitorSource)} }; module.exports = CleanupSubject;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
);

for (const enabled of [false, true]) {
  test(`Chatwoot cleanup respects CHATWOOT_ENABLED=${enabled} without skipping Baileys cleanup`, async () => {
    const module = { exports: {} };
    vm.runInNewContext(cleanupCode, { module });
    const service = new module.exports();
    const calls = [];
    Object.assign(service, {
      db: { SAVE_DATA: { INSTANCE: false } },
      redis: { REDIS: { ENABLED: false } },
      configService: { get: () => ({ ENABLED: enabled }) },
      chatwootCache: { deleteAll: async (name) => calls.push(`chatwoot:${name}`) },
      baileysCache: { deleteAll: async (id) => calls.push(`baileys:${id}`) },
    });
    await service.cleaningUp('test-instance', 'test-id');
    assert.deepEqual(calls, enabled ? ['chatwoot:test-instance', 'baileys:test-id'] : ['baileys:test-id']);
  });
}

test('cleanup works with a null Chatwoot cache when disabled', async () => {
  const module = { exports: {} };
  vm.runInNewContext(cleanupCode, { module });
  const service = new module.exports();
  Object.assign(service, {
    db: { SAVE_DATA: { INSTANCE: false } },
    redis: { REDIS: { ENABLED: false } },
    configService: { get: () => ({ ENABLED: false }) },
    chatwootCache: null,
  });
  await service.cleaningUp('test-instance');
});
