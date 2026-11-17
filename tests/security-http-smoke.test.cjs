const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { WebSocket, WebSocketServer } = require('ws');
const { fetch: undiciFetch } = require('undici');
const { loadTs } = require('./helpers/ts-loader.cjs');

test('IPv4-mapped IPv6 trust subnets cannot trust arbitrary external IPv4 addresses', () => {
  const proxyaddr = require('proxy-addr');
  assert.equal(proxyaddr.compile('::ffff:10.0.0.0/8')('203.0.113.20'), false);
  assert.equal(proxyaddr.compile('::ffff:10.0.0.0/104')('10.1.2.3'), true);
  assert.equal(proxyaddr.compile('::ffff:10.0.0.0/104')('203.0.113.20'), false);
});

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
class Logger {
  error() {}
  log() {}
  warn() {}
}
const sizes = loadTs('src/utils/mediaSize.ts');
const { RouterBroker } = loadTs('src/api/abstract/abstract.router.ts', {
  '@config/logger.config': { Logger },
  '@exceptions': { BadRequestException: Error },
});
test('native message route accepts multipart bytes with real Express, multer and form-data', async (t) => {
  const dtos = new Proxy({}, { get: () => class Payload {} });
  const schemas = new Proxy({}, { get: () => ({ type: 'object' }) });
  let delivered;
  const { MessageRouter } = loadTs('src/api/routes/sendMessage.router.ts', {
    '@api/abstract/abstract.router': { RouterBroker },
    '@api/dto/sendMessage.dto': dtos,
    '@api/server.module': {
      sendMessageController: {
        sendMedia: async (instance, data, file) => {
          delivered = { instance, data, file };
          return { accepted: true };
        },
      },
    },
    '@utils/mediaSize': sizes,
    '@validate/validate.schema': schemas,
    './index.router': { HttpStatus: { CREATED: 201, OK: 200 } },
  });
  const app = express();
  app.use(express.json());
  app.use('/message', new MessageRouter((req, res, next) => next()).router);
  const base = await listen(t, http.createServer(app));
  const form = new FormData();
  form.append('number', '12025550101');
  form.append('mediatype', 'document');
  form.append('file', Buffer.from('synthetic-upload'), { filename: 'fixture.txt', contentType: 'text/plain' });
  const result = await axios.post(base + '/message/sendMedia/own', form, {
    headers: form.getHeaders(),
    proxy: false,
    timeout: 1000,
  });
  assert.equal(result.status, 201);
  assert.equal(delivered.instance.instanceName, 'own');
  assert.equal(delivered.file.buffer.toString(), 'synthetic-upload');
  assert.equal(delivered.data.mediatype, 'document');
});
test('real URL media download preserves bytes and enforces declared size limits', async (t) => {
  const base = await listen(
    t,
    http.createServer((req, res) => {
      if (req.url === '/too-large') {
        res.writeHead(200, { 'Content-Length': 17 * 1024 * 1024 });
        res.end(Buffer.alloc(17 * 1024 * 1024));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from('synthetic-media'));
    }),
  );
  const source = ts.createSourceFile(
    'service.ts',
    fs.readFileSync(
      path.join(__dirname, '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'),
      'utf8',
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const cls = source.statements.find((n) => ts.isClassDeclaration(n) && n.name.text === 'BaileysStartupService');
  const methods = ['getAxiosMediaOptions', 'downloadRemoteMedia']
    .map((name) => cls.members.find((n) => n.name?.getText(source) === name).getText(source))
    .join('\n');
  const code = ts.transpileModule(`class Subject { ${methods} };module.exports=Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, axios, Buffer, ...sizes, ProxyUnavailableError: Error });
  const subject = new module.exports();
  const result = await subject.downloadRemoteMedia(base + '/image', 'image');
  assert.equal(result.buffer.toString(), 'synthetic-media');
  assert.equal(result.contentType, 'image/png');
  await assert.rejects(subject.downloadRemoteMedia(base + '/too-large', 'image'));
});
test('real undici ProxyAgent negotiates CONNECT and delivers the HTTP response', async (t) => {
  const target = await listen(
    t,
    http.createServer((req, res) => res.end('through-proxy')),
  );
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
    }
  });
  const proxyUrl = await listen(t, proxy);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
  });
  const { makeProxyAgentUndici } = loadTs('src/utils/makeProxyAgent.ts');
  const agent = makeProxyAgentUndici(proxyUrl, { headersTimeoutMs: 1000, bodyTimeoutMs: 1000 });
  try {
    assert.equal(
      await (await undiciFetch(target, { dispatcher: agent, signal: AbortSignal.timeout(2000) })).text(),
      'through-proxy',
    );
  } finally {
    await agent.close();
    for (const socket of sockets) socket.destroy();
  }
});
test('ws server and client retain message and close behavior', async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (bytes) => socket.send(bytes)));
  const base = await listen(t, server);
  t.after(() => wss.close());
  const client = new WebSocket(base.replace('http:', 'ws:'));
  await once(client, 'open');
  const reply = once(client, 'message');
  client.send('synthetic-echo');
  assert.equal((await reply)[0].toString(), 'synthetic-echo');
  client.close();
  await once(client, 'close');
});
test('actual webhook controller delivers JSON and stable idempotency headers through real axios', async (t) => {
  const received = [];
  const base = await listen(
    t,
    http.createServer(async (req, res) => {
      const parts = [];
      for await (const chunk of req) parts.push(chunk);
      received.push({ headers: req.headers, body: JSON.parse(Buffer.concat(parts)) });
      res.end('ok');
    }),
  );
  const { EventController } = loadTs('src/api/integrations/event/event.controller.ts');
  const { WebhookController } = loadTs('src/api/integrations/event/webhook/webhook.controller.ts', {
    '@config/logger.config': { Logger },
    '../event.controller': { EventController },
    '@config/env.config': {
      configService: {
        get: (name) => (name === 'LOG' ? { LEVEL: [] } : { GLOBAL: { ENABLED: false }, RETRY: { MAX_ATTEMPTS: 1 } }),
      },
    },
  });
  const ctl = new WebhookController({}, {});
  const data = {
    instanceName: 'own',
    origin: 'smoke',
    event: 'messages.upsert',
    data: { key: { id: 'fixture' } },
    serverUrl: base,
    dateTime: '2026-11-16T00:00:00Z',
    sender: 'synthetic',
    local: true,
    webhookDelivery: {
      timeoutMs: 1000,
      maxAttempts: 1,
      throwOnFailure: true,
      webhookSnapshot: { enabled: true, url: base, events: ['MESSAGES_UPSERT'], instanceId: 'own-id' },
    },
  };
  await ctl.emit(data);
  await ctl.emit(data);
  assert.equal(received.length, 2);
  assert.equal(received[0].body.data.key.id, 'fixture');
  assert.equal(received[0].headers['idempotency-key'], received[1].headers['idempotency-key']);
  assert.ok(received[0].headers['idempotency-key']);
});
