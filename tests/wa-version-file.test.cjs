const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/ts-loader.cjs');

test('last-good cache survives resolver restart using an actual filesystem file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evoapi-wa-version-test-'));
  const cache = path.join(directory, 'wa-version.json');
  t.after(async () => {
    await fs.unlink(cache).catch(() => {});
    await fs.rmdir(directory);
  });
  const bundled = (await import('baileys')).DEFAULT_CONNECTION_CONFIG.version;
  class Logger {
    info() {}
    warn() {}
  }
  class Agent {
    async destroy() {}
  }
  let requests = 0;
  function start(online) {
    return loadTs(
      'src/utils/fetchLatestWaWebVersion.ts',
      {
        '@config/logger.config': { Logger },
        baileys: {
          DEFAULT_CONNECTION_CONFIG: { version: bundled },
          fetchLatestBaileysVersion: async () => ({ version: bundled, isLatest: false }),
        },
        undici: {
          Agent,
          fetch: async () => {
            requests++;
            if (!online) throw Error('Synthetic GitHub outage');
            return {
              ok: true,
              headers: { get: () => null },
              text: async () => 'const version = [2, 3000, 1234567890];',
            };
          },
        },
      },
      { AbortController, process: { ...process, env: { WA_VERSION_CACHE_PATH: cache } } },
    );
  }
  const first = start(true);
  assert.equal((await first.fetchLatestWaWebVersion()).version[2], 1234567890);
  const stored = JSON.parse(await fs.readFile(cache, 'utf8'));
  assert.equal(stored.source, 'github');
  assert.equal(typeof stored.fetchedAt, 'number');
  const restarted = start(false);
  const result = await restarted.fetchLatestWaWebVersion();
  assert.equal(result.source, 'persisted');
  assert.equal(result.version[2], 1234567890);
  assert.equal(result.isLatest, false);
  assert.equal(requests, 1);
});

test('default cache path may be unwritable without blocking socket version selection', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evoapi-wa-unwritable-'));
  const blockedDirectory = path.join(directory, 'instances');
  // A file at the directory path makes real filesystem persistence impossible on Windows and Unix.
  await fs.writeFile(blockedDirectory, 'synthetic cache obstruction');
  t.after(async () => {
    await fs.unlink(blockedDirectory);
    await fs.rmdir(directory);
  });
  const events = [];
  class Logger {
    info(event) {
      events.push(event);
    }
    warn(event) {
      events.push(event);
    }
  }
  class Agent {
    async destroy() {}
  }
  const bundled = (await import('baileys')).DEFAULT_CONNECTION_CONFIG.version;
  function start(online) {
    return loadTs(
      'src/utils/fetchLatestWaWebVersion.ts',
      {
        '@config/logger.config': { Logger },
        baileys: { DEFAULT_CONNECTION_CONFIG: { version: bundled } },
        undici: {
          Agent,
          fetch: async () => {
            if (!online) throw Error('Synthetic offline response');
            return {
              ok: true,
              headers: { get: () => null },
              text: async () => 'const version = [2, 3000, 1234567890];',
            };
          },
        },
      },
      { AbortController, process: { env: {}, cwd: () => directory, pid: process.pid } },
    );
  }
  const offline = start(false);
  const fallback = await offline.fetchLatestWaWebVersion();
  assert.equal(fallback.source, 'bundled');
  assert.equal(fallback.version.join('.'), bundled.join('.'));
  assert.equal(fallback.isLatest, false);
  const online = start(true);
  assert.equal((await online.fetchLatestWaWebVersion()).version[2], 1234567890);
  assert.equal(online.getWaVersionTelemetry().persistenceFailure, 1);
  assert.equal((await online.fetchLatestWaWebVersion()).source, 'memory');
  assert.ok(events.some((event) => event.event === 'wa_version.persistence_failed'));
  assert.ok(events.some((event) => event.event === 'wa_version.selected'));
  assert.equal(await fs.readFile(blockedDirectory, 'utf8'), 'synthetic cache obstruction');
});

test('the default maximum cache age rejects an eight-day-old persisted version without new variables', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evoapi-wa-default-age-'));
  const instances = path.join(directory, 'instances');
  const cache = path.join(instances, 'wa-web-version.json');
  await fs.mkdir(instances);
  await fs.writeFile(
    cache,
    JSON.stringify({
      version: [2, 3000, 1234567890],
      fetchedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      source: 'github',
    }),
  );
  t.after(async () => {
    await fs.unlink(cache);
    await fs.rmdir(instances);
    await fs.rmdir(directory);
  });
  const bundled = (await import('baileys')).DEFAULT_CONNECTION_CONFIG.version;
  class Logger {
    info() {}
    warn() {}
  }
  class Agent {
    async destroy() {}
  }
  const resolver = loadTs(
    'src/utils/fetchLatestWaWebVersion.ts',
    {
      '@config/logger.config': { Logger },
      baileys: { DEFAULT_CONNECTION_CONFIG: { version: bundled } },
      undici: {
        Agent,
        fetch: async () => {
          throw Error('Synthetic outage');
        },
      },
    },
    { AbortController, process: { env: {}, cwd: () => directory, pid: process.pid } },
  );
  const selected = await resolver.fetchLatestWaWebVersion();
  assert.equal(selected.source, 'bundled');
  assert.equal(selected.version.join('.'), bundled.join('.'));
  assert.equal(selected.isLatest, false);
});
