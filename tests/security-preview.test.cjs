const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns/promises');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const preview = require('link-preview-js');

test('Baileys preview rejects loopback before requesting a local resource', async (t) => {
  let hits = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  t.mock.method(require('node:dns'), 'lookup', (...args) => {
    const callback = args.at(-1);
    queueMicrotask(() => args[1]?.all
      ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4));
  });
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Synthetic internal resource</title></head></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dependency = process.env.BAILEYS_PREVIEW_BASELINE;
  const { getUrlInfo } = await import(dependency ? pathToFileURL(dependency).href : 'baileys/lib/Utils/link-preview.js');
  let info;
  try {
    info = await getUrlInfo(`http://synthetic-preview.example:${server.address().port}/`, { fetchOpts: { timeout: 500 } });
  } catch (error) {
    assert.match(error.message, /SSRF/);
  }
  assert.equal(info, undefined);
  assert.equal(hits, 0);
});
test('previews reject private, loopback, link-local and metadata destinations without a TCP connection', async (t) => {
  let connections = 0;
  t.mock.method(net.Socket.prototype, 'connect', function () {
    connections++;
    throw Error('fixture forbids outbound connections');
  });
  for (const host of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '[::1]',
    '[fc00::1]',
    '[fe80::1]',
  ]) {
    await assert.rejects(preview.getLinkPreview(`http://${host}/`, { timeout: 100 }), /SSRF|did not receive a valid/, host);
  }
  assert.equal(connections, 0);
});
test('DNS answers pointing to private addresses are rejected before connect', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(preview.getLinkPreview('http://synthetic-preview.example/', { timeout: 100 }), /SSRF/);
});
test('validated DNS addresses are pinned on the TCP connection instead of resolving the host again', async (t) => {
  let lookups = 0,
    pinned;
  t.mock.method(dns, 'lookup', async () => [{ address: ++lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }]);
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    const opts = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof opts?.lookup === 'function')
      opts.lookup('synthetic-preview.example', { all: true }, (error, addresses) => {
        assert.ifError(error);
        pinned = addresses;
      });
    throw Error('fixture stops validated connection');
  });
  await assert.rejects(preview.getLinkPreview('http://synthetic-preview.example/', { timeout: 100 }));
  assert.equal(lookups, 1);
  assert.deepEqual(pinned, [{ address: '93.184.216.34', family: 4 }]);
});
test('Baileys resolves the protected Node entry and the preview response shape remains compatible', async () => {
  const requireFromBaileys = createRequire(require.resolve('baileys'));
  assert.equal(requireFromBaileys.resolve('link-preview-js'), require.resolve('link-preview-js'));
  const result = await preview.getPreviewFromContent({
    url: 'https://example.com/page',
    headers: { 'content-type': 'text/html' },
    data: '<html><head><title>Fixture title</title><meta name="description" content="Fixture description"><meta property="og:image" content="https://example.com/image.png"></head></html>',
  });
  assert.equal(result.title, 'Fixture title');
  assert.equal(result.description, 'Fixture description');
  assert.equal(result.images[0], 'https://example.com/image.png');
});
