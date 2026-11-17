const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');

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
    URL,
  });
  return module.exports;
}

const deadline = load('src/utils/deadline.ts');
const media = load('src/utils/mediaDownload.ts', { '@utils/deadline': deadline });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const neverAnswers = () => new Promise(() => {});

// Same shape the service uses to describe a failed download in the webhook.
const mediaErrorPayload = (error) => ({ code: error?.code || 'MEDIA_DOWNLOAD_FAILED', message: error?.message });

test('a media download that never answers is released with a MEDIA_DOWNLOAD_TIMEOUT error', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    media.downloadWithinDeadline(() => neverAnswers(), 40),
    (error) => error.code === 'MEDIA_DOWNLOAD_TIMEOUT' && error.timeoutMs === 40,
  );
  assert.ok(Date.now() - startedAt < 200);
});

test('a media download that finishes in time is returned untouched and receives an absolute deadline', async () => {
  let received;
  const before = Date.now();
  const result = await media.downloadWithinDeadline(async (deadlineAtMs) => {
    received = deadlineAtMs;
    return { buffer: Buffer.from('ok') };
  }, 500);

  assert.equal(result.buffer.toString(), 'ok');
  assert.ok(received >= before + 500 && received <= Date.now() + 500);
});

test('retries stop once the deadline passed, and an undefined deadline never throws', () => {
  assert.doesNotThrow(() => media.assertBeforeDeadline(undefined));
  assert.doesNotThrow(() => media.assertBeforeDeadline(Date.now() + 1_000));
  assert.throws(() => media.assertBeforeDeadline(Date.now() - 1, 123), { code: 'MEDIA_DOWNLOAD_TIMEOUT', timeoutMs: 123 });
});

test('a message whose media never downloads is still delivered with mediaError and does not hold the next one', async () => {
  // Same shape as the upsert path: download (bounded) -> mediaError on failure -> webhook queued -> next message.
  const delivered = [];
  const handle = async (name, download) => {
    const messageRaw = { name };
    try {
      const downloaded = await download();
      messageRaw.base64 = downloaded.buffer.toString('base64');
    } catch (error) {
      messageRaw.mediaError = mediaErrorPayload(error);
    }
    delivered.push({ ...messageRaw, at: Date.now() });
  };

  const startedAt = Date.now();
  let chain = Promise.resolve();
  chain = chain.then(() => handle('image', () => media.downloadWithinDeadline(() => neverAnswers(), 60)));
  chain = chain.then(() => handle('text-after-the-image', async () => ({ buffer: Buffer.from('hi') })));
  await chain;

  assert.deepEqual(
    delivered.map((m) => m.name),
    ['image', 'text-after-the-image'],
  );
  assert.equal(delivered[0].mediaError.code, 'MEDIA_DOWNLOAD_TIMEOUT');
  assert.equal(delivered[1].mediaError, undefined);
  assert.ok(delivered[1].at - startedAt < 250, 'the chain was held for roughly the media deadline, not for minutes');
});

function loadProxyHelper() {
  const calls = { proxyAgent: [], socks: [] };
  class ProxyAgent {
    constructor(options) {
      calls.proxyAgent.push(options);
    }
  }
  const helper = load('src/utils/makeProxyAgent.ts', {
    'fetch-socks': {
      socksDispatcher: (proxy, options) => {
        calls.socks.push({ proxy, options });
        return { socks: true };
      },
    },
    'https-proxy-agent': { HttpsProxyAgent: class {} },
    'socks-proxy-agent': { SocksProxyAgent: class {} },
    undici: { ProxyAgent },
  });
  return { helper, calls };
}

test('media downloads through an HTTP proxy get idle timeouts instead of undici\'s 300s defaults', () => {
  const { helper, calls } = loadProxyHelper();
  helper.makeProxyAgentUndici('http://user:pass@10.0.0.1:8080', { headersTimeoutMs: 15000, bodyTimeoutMs: 15000 });

  assert.equal(calls.proxyAgent.length, 1);
  assert.equal(calls.proxyAgent[0].uri, 'http://user:pass@10.0.0.1:8080');
  assert.equal(calls.proxyAgent[0].headersTimeout, 15000);
  assert.equal(calls.proxyAgent[0].bodyTimeout, 15000);
});

test('SOCKS proxies receive the same timeouts and callers without timeouts keep the previous behaviour', () => {
  const { helper, calls } = loadProxyHelper();
  helper.makeProxyAgentUndici({ host: '10.0.0.2', port: '1080', protocol: 'socks5' }, { headersTimeoutMs: 9000 });
  assert.equal(calls.socks[0].options.headersTimeout, 9000);
  assert.equal('bodyTimeout' in calls.socks[0].options, false);

  helper.makeProxyAgentUndici('http://10.0.0.1:8080');
  assert.equal(calls.proxyAgent[0], 'http://10.0.0.1:8080', 'a plain string, exactly as before');
  helper.makeProxyAgentUndici({ host: '10.0.0.2', port: '1080', protocol: 'socks5' });
  assert.equal(calls.socks[1].options, undefined);
});

// The service itself needs a live Baileys socket, so the wiring is pinned with structural checks on its source.
const serviceSource = fs.readFileSync(
  path.join(root, 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'),
  'utf8',
);
const between = (from, to) => {
  const start = serviceSource.indexOf(from);
  const end = serviceSource.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not locate ${from}`);
  return serviceSource.slice(start, end);
};

test('read receipts no longer hold the event chain and run under an explicit timeout', () => {
  const handler = between("'messages.upsert': async (", "'messages.update': async (");
  assert.doesNotMatch(handler, /await this\.client\.readMessages\(/);
  assert.equal((handler.match(/this\.markAsRead\(received\.key\)/g) ?? []).length, 2);

  const markAsRead = between('private markAsRead(', 'private getMediaDownloadOptions(');
  assert.match(markAsRead, /withDeadline\(/);
  assert.match(markAsRead, /READ_RECEIPT_TIMEOUT_MS/);
  assert.match(markAsRead, /\.catch\(/);
});

test('both webhookBase64 download paths run under the media deadline', () => {
  assert.equal((serviceSource.match(/downloadMediaOnce = \(\) => \{\s+mediaDownloadPromise \?\?= downloadWithinDeadline\(/g) ?? []).length, 2);
  assert.doesNotMatch(serviceSource, /mediaDownloadPromise \?\?= this\.getBase64FromMediaMessage\(/);
  assert.match(serviceSource, /makeProxyAgentUndici\(proxy, \{\s+headersTimeoutMs: this\.mediaDownloadTimeoutMs/);
});

test('the media timeout is configurable, defaults to 15s and is documented in .env.example', () => {
  const config = fs.readFileSync(path.join(root, 'src/config/env.config.ts'), 'utf8');
  assert.match(config, /MEDIA_DOWNLOAD_TIMEOUT_MS: Number\.parseInt\(process\.env\?\.WEBHOOK_MEDIA_DOWNLOAD_TIMEOUT_MS\) \|\| 15000/);
  assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /^WEBHOOK_MEDIA_DOWNLOAD_TIMEOUT_MS=15000$/m);
});
