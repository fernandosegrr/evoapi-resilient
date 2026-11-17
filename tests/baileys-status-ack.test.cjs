const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const socketPath = path.join(root, 'node_modules/baileys/lib/Socket/messages-recv.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadStatusHandler(sendMessageAck) {
  const source = fs.readFileSync(socketPath, 'utf8');
  const ast = ts.createSourceFile(socketPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const socket = ast.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(ast) === 'makeMessagesRecvSocket',
      ),
  ).declarationList.declarations[0].initializer.body;
  const declarations = new Map();
  for (const statement of socket.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        declarations.set(declaration.name.getText(ast), statement.getText(ast));
      }
    }
  }
  const registration = socket.statements.find(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(ast) === 'ws.on' &&
      statement.expression.arguments[0]?.text === 'CB:status',
  );
  assert.ok(registration, 'Baileys must register CB:status');
  assert.ok(declarations.has('handleStatus'), 'Baileys must provide the shared status ACK handler');

  const offlineSource = fs.readFileSync(
    path.join(root, 'node_modules/baileys/lib/Utils/offline-node-processor.js'),
    'utf8',
  );
  const offlineModule = { exports: {} };
  const { outputText } = ts.transpileModule(offlineSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(outputText, { exports: offlineModule.exports });

  const ws = { isOpen: true, on: (event, handler) => listeners.set(event, handler) };
  const listeners = new Map();
  const errors = [];
  const handled = [];
  const context = {
    ws,
    sendMessageAck,
    onUnexpectedError: (error, context) => errors.push({ error, context }),
    makeOfflineNodeProcessor: offlineModule.exports.makeOfflineNodeProcessor,
    handleMessage: async () => handled.push('message'),
    handleCall: async () => handled.push('call'),
    handleReceipt: async () => handled.push('receipt'),
    handleNotification: async () => handled.push('notification'),
    setImmediate,
  };
  vm.runInNewContext(
    [
      declarations.get('handleStatus'),
      declarations.get('offlineNodeProcessor'),
      registration.getText(ast),
      'globalThis.enqueue = offlineNodeProcessor.enqueue;',
    ].join('\n'),
    context,
  );
  return { receive: listeners.get('CB:status'), enqueue: context.enqueue, errors, handled };
}

test('a top-level status node is acknowledged once with the original node', async () => {
  const calls = [];
  const handler = loadStatusHandler(async (...args) => calls.push(args));
  const node = { tag: 'status', attrs: { id: 'status-1', from: 's.whatsapp.net' } };
  handler.receive(node);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0], node);
  assert.deepEqual(handler.errors, []);
  assert.deepEqual(handler.handled, []);
});

test('a rejected live status ACK is reported and subsequent nodes still work', async () => {
  const failure = new Error('ACK send failed');
  let calls = 0;
  const handler = loadStatusHandler(async () => {
    if (++calls === 1) throw failure;
  });
  handler.receive({ tag: 'status', attrs: { id: 'failed' } });
  await tick();
  handler.receive({ tag: 'status', attrs: { id: 'next' } });
  await tick();
  assert.equal(calls, 2);
  assert.deepEqual(handler.errors, [{ error: failure, context: 'acking status stanza' }]);
});

test('offline status ACKs are awaited in order together with other stanza types', async () => {
  const calls = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const handler = loadStatusHandler(async (node) => {
    calls.push(node.attrs.id);
    if (node.attrs.id === 'first') await pending;
  });
  handler.receive({ tag: 'status', attrs: { id: 'first', offline: '1' } });
  handler.enqueue('receipt', { attrs: {} });
  handler.receive({ tag: 'status', attrs: { id: 'second', offline: '1' } });
  await tick();
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(handler.handled, []);
  release();
  await tick();
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(handler.handled, ['receipt']);
  assert.deepEqual(handler.errors, []);
});

test('a rejected offline status ACK allows the offline queue to continue', async () => {
  const failure = new Error('offline ACK send failed');
  const handler = loadStatusHandler(async () => {
    throw failure;
  });
  handler.receive({ tag: 'status', attrs: { id: 'failed', offline: '1' } });
  handler.enqueue('message', { attrs: {} });
  await tick();
  assert.deepEqual(handler.errors, [{ error: failure, context: 'acking status stanza' }]);
  assert.deepEqual(handler.handled, ['message']);
});

test('Docker installs the patch before building and retains patched runtime dependencies', () => {
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const metrics = fs.readFileSync(path.join(root, 'Dockerfile.metrics'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.postinstall, 'patch-package --error-on-fail');
  assert.ok(manifest.dependencies['patch-package']);
  for (const source of [docker, metrics]) {
    assert.ok(source.indexOf('COPY ./patches') >= 0 || source.indexOf('COPY patches') >= 0);
    assert.ok(source.indexOf('patches ./patches') < source.indexOf('RUN npm ci'));
    assert.match(source, /COPY --from=(builder|base) \/evolution\/node_modules \.\/node_modules/);
  }
});
