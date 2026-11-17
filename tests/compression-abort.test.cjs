const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire, Module } = require('node:module');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const zlib = require('node:zlib');
const express = require('express');

function observedCompression(streams) {
  // Execute the installed middleware unchanged, observing its real native zlib streams.
  const entry = process.env.COMPRESSION_MODULE || require.resolve('compression');
  const localRequire = createRequire(entry);
  const observedZlib = Object.create(zlib);
  for (const name of ['createGzip', 'createDeflate', 'createBrotliCompress']) {
    Object.defineProperty(observedZlib, name, {
      value: (...args) => {
        const stream = zlib[name](...args);
        streams.push(stream);
        return stream;
      },
    });
  }
  const mod = { exports: {} };
  const execute = vm.runInThisContext(Module.wrap(fs.readFileSync(entry, 'utf8')), { filename: entry });
  execute(
    mod.exports,
    (name) => (name === 'zlib' ? observedZlib : localRequire(name)),
    mod,
    entry,
    path.dirname(entry),
  );
  return mod.exports;
}

async function listen(t, app) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(url, encoding) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'Accept-Encoding': encoding }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      res.once('error', reject);
    });
    req.once('error', reject);
  });
}

test('aborting compressed HTTP responses destroys the native zlib streams', { timeout: 10000 }, async (t) => {
  const streams = [];
  t.after(() => {
    for (const stream of streams) {
      stream.close();
      stream.destroy();
    }
  });
  const app = express();
  app.use(observedCompression(streams)({ threshold: 0 }));
  let closed;
  app.get('/stream', (req, res) => {
    res.type('text/plain');
    const timer = setInterval(() => {
      res.write(randomBytes(4096));
      res.flush();
    }, 5);
    res.once('close', () => {
      clearInterval(timer);
      closed();
    });
    res.write(randomBytes(4096));
    res.flush();
  });
  const url = await listen(t, app);
  for (const encoding of ['gzip', 'deflate', 'br']) {
    for (let i = 0; i < 3; i++) {
      const responseClosed = new Promise((resolve) => {
        closed = resolve;
      });
      await new Promise((resolve, reject) => {
        const req = http.get(
          `${url}/stream`,
          {
            headers: { 'Accept-Encoding': encoding },
            agent: false,
          },
          (res) => {
            res.once('error', (error) => {
              if (error.code !== 'ECONNRESET') reject(error);
            });
            res.once('data', () => {
              assert.equal(res.headers['content-encoding'], encoding);
              res.destroy();
              resolve();
            });
          },
        );
        req.once('error', reject);
      });
      await responseClosed;
      await new Promise((resolve) => setImmediate(resolve));
      const stream = streams.at(-1);
      assert.ok(stream, `created a real ${encoding} stream`);
      assert.equal(stream.destroyed, true, `${encoding} stream destroyed after client abort`);
      assert.equal(stream._handle, null, `${encoding} native handle released after client abort`);
    }
  }
  assert.equal(streams.length, 9);
});

test('normal gzip, deflate and Brotli responses preserve the full JSON payload', async (t) => {
  const compression = require('compression');
  const app = express();
  const payload = JSON.stringify({ message: 'synthetic compression fixture '.repeat(1000) });
  app.use(compression());
  app.get('/', (req, res) => res.type('application/json').send(payload));
  const url = await listen(t, app);
  for (const [encoding, decode] of [
    ['gzip', zlib.gunzipSync],
    ['deflate', zlib.inflateSync],
    ['br', zlib.brotliDecompressSync],
  ]) {
    const response = await request(url, encoding);
    assert.equal(response.headers['content-encoding'], encoding);
    assert.equal(decode(response.body).toString(), payload);
    assert.match(response.headers.vary, /Accept-Encoding/i);
  }
});

test('Cache-Control no-transform prevents compression regardless of directive casing', async (t) => {
  const app = express();
  app.use(require('compression')());
  const payload = 'synthetic no-transform fixture '.repeat(1000);
  app.get('/', (req, res) => res.set('Cache-Control', 'public, NO-TRANSFORM').type('text/plain').send(payload));
  const response = await request(await listen(t, app), 'gzip');
  assert.equal(response.headers['content-encoding'], undefined);
  assert.equal(response.body.toString(), payload);
});
