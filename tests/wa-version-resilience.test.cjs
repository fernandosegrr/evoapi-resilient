const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { versionHarness, declaration, fresh } = require('./helpers/wa-version-harness.cjs');

test('remote declaration survives moved lines, comments and multiline formatting', async () => {
  const h = versionHarness(
    async () => '// unrelated\n'.repeat(20) + 'export const version: WAVersion = [\n2,\n3000,\n1234567890,\n];\n',
  );
  assert.equal((await h.lookup()).version.join('.'), fresh.join('.'));
  for (const invalid of [
    'const version=[2,3000,1,4];',
    'const version=[2,3000,NaN];',
    'const version=[2,3000,9007199254740992];',
    declaration(fresh) + declaration(fresh),
  ]) {
    const bad = versionHarness(async () => invalid);
    assert.equal((await bad.lookup()).source, 'bundled');
  }
});
test('restart restores a valid last-good file during GitHub outage', async () => {
  const first = versionHarness();
  await first.lookup();
  await first.settle();
  const stored = JSON.parse(first.files.get('synthetic-wa-version.json'));
  const restarted = versionHarness(
    async () => {
      throw Error('offline');
    },
    { persisted: stored },
  );
  const result = await restarted.lookup();
  assert.equal(result.source, 'persisted');
  assert.equal(result.version.join('.'), fresh.join('.'));
  assert.equal(result.isLatest, false);
  assert.equal(restarted.calls(), 0);
  restarted.advance(24 * 60 * 60 * 1000);
  assert.equal((await restarted.lookup()).source, 'last-good');
  await restarted.settle();
  assert.equal(restarted.calls(), 1);
});
test('expired, future-dated or bundled persistence never becomes last-good', async () => {
  for (const persisted of [
    { version: fresh, fetchedAt: 0, source: 'github' },
    { version: fresh, fetchedAt: 2_000_000, source: 'github' },
    { version: fresh, fetchedAt: 999_999, source: 'bundled' },
  ]) {
    const h = versionHarness(
      async () => {
        throw Error('offline');
      },
      { persisted, maxAgeMs: 100 },
    );
    assert.equal((await h.lookup()).source, 'bundled');
  }
});
test('a read-only cache never prevents socket callers from obtaining a usable version', async () => {
  const h = versionHarness(undefined, { diskFailure: true });
  assert.equal((await h.lookup()).version.join('.'), fresh.join('.'));
  assert.equal(h.getWaVersionTelemetry().persistenceFailure, 1);
  assert.ok(h.logs.some((log) => log.event === 'wa_version.selected' && log.ageMs === 0));
});
test('cold socket callers fall back within 250ms while one shared lookup continues', async () => {
  let resolve;
  const h = versionHarness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const started = performance.now();
  const result = await Promise.all(Array.from({ length: 19 }, () => h.lookup({ timeout: 1000 })));
  assert.ok(performance.now() - started < 900);
  assert.equal(h.calls(), 1);
  assert.ok(result.every((value) => value.source === 'bundled'));
  resolve(declaration(fresh));
  await h.settle();
  assert.equal((await h.lookup()).isLatest, true);
});
test('actual root route answers with a fallback while the version server never answers', async (t) => {
  const h = versionHarness(() => new Promise(() => {}));
  await h.lookup({ timeout: 40, maxWaitMs: 0 });
  const rootPath = path.join(__dirname, '../src/api/routes/index.router.ts');
  const ast = ts.createSourceFile(rootPath, fs.readFileSync(rootPath, 'utf8'), ts.ScriptTarget.Latest, true);
  let handler;
  function visit(n) {
    if (ts.isCallExpression(n) && n.arguments[0]?.text === '/' && ts.isArrowFunction(n.arguments[1]))
      handler = n.arguments[1].getText(ast);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(handler);
  const code = ts.transpileModule(`module.exports=${handler}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    fetchLatestWaWebVersion: h.lookup,
    getWaVersionTelemetry: h.getWaVersionTelemetry,
    HttpStatus: { OK: 200 },
    packageJson: { version: 'synthetic' },
    databaseConfig: { CONNECTION: { CLIENT_NAME: 'synthetic' } },
    serverConfig: { DISABLE_MANAGER: true },
  });
  const app = express();
  app.get('/', module.exports);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(900) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.whatsappWebVersionSource, 'bundled');
  assert.equal(body.whatsappWebVersion, h.bundled.join('.'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(h.agents[0].destroyed);
});
