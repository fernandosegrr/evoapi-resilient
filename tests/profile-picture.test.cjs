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
  });
  return module.exports;
}

const deadline = load('src/utils/deadline.ts');
const resolverModule = load('src/utils/profilePictureResolver.ts', { '@utils/deadline': deadline });
const { ProfilePictureResolver, omitEmptyPhoto, isProfilePictureJid } = resolverModule;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PN = (n) => `5214620000${String(n).padStart(3, '0')}@s.whatsapp.net`;
const neverAnswers = () => new Promise(() => {});

function resolverWith(fetchUrl, options = {}) {
  return new ProfilePictureResolver({ fetchUrl, timeoutMs: 40, ...options });
}

test('withDeadline settles with the work when it finishes in time and rejects with the supplied error otherwise', async () => {
  assert.equal(await deadline.withDeadline(Promise.resolve('ok'), 50), 'ok');
  await assert.rejects(
    deadline.withDeadline(neverAnswers(), 20, () => Object.assign(new Error('too slow'), { code: 'SLOW' })),
    { code: 'SLOW' },
  );
  await assert.rejects(deadline.withDeadline(neverAnswers(), 20), { code: 'DEADLINE_EXCEEDED' });
});

test('withDeadline does not leave an unhandled rejection when the work fails after the deadline', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    let fail;
    const late = new Promise((_, reject) => {
      fail = reject;
    });
    await assert.rejects(deadline.withDeadline(late, 10), { code: 'DEADLINE_EXCEEDED' });
    fail(new Error('boom after the deadline'));
    await sleep(30);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('a profile picture query that never answers neither blocks the caller nor holds its slot forever', async () => {
  let calls = 0;
  const resolver = resolverWith(() => {
    calls++;
    return neverAnswers();
  });

  const startedAt = Date.now();
  assert.equal(resolver.request(PN(1)), true);
  assert.equal(resolver.lookup(PN(1)).state, 'unknown');
  assert.ok(Date.now() - startedAt < 20, 'request() must return immediately');

  // 40ms timeout plus the resolver's 250ms backstop for a fetcher that ignores its own timeout
  await sleep(360);
  assert.equal(calls, 1);
  assert.equal(resolver.lookup(PN(1)).state, 'none', 'a timed-out lookup is cached as a failure');
  assert.deepEqual({ ...resolver.stats() }, { active: 0, queued: 0, cached: 1 });
});

test('a burst of 10 messages is dispatched without waiting for a photo query that never answers', async () => {
  // Same shape as the per-instance event chain: messages are handled one after another and the webhook is
  // queued before the contact step. Before the fix every message awaited the photo query (60s in production).
  const resolver = resolverWith(neverAnswers, { timeoutMs: 300 });
  const dispatchedAt = [];
  let chain = Promise.resolve();

  const handle = async (n) => {
    dispatchedAt.push(Date.now());
    const photo = resolver.lookup(PN(n));
    if (photo.state === 'unknown') resolver.request(PN(n));
  };

  const startedAt = Date.now();
  for (let n = 0; n < 10; n++) chain = chain.then(() => handle(n));
  await chain;

  assert.equal(dispatchedAt.length, 10);
  const gaps = dispatchedAt.slice(1).map((at, i) => at - dispatchedAt[i]);
  assert.ok(Math.max(...gaps) < 100, `largest gap between dispatches was ${Math.max(...gaps)}ms`);
  assert.ok(Date.now() - startedAt < 150, 'the whole burst must not take a single photo timeout (300ms here)');
});

test('the next message of the same instance is not delayed by an unanswered photo query', async () => {
  const resolver = resolverWith(neverAnswers, { timeoutMs: 400 });
  let chain = Promise.resolve();
  const dispatched = {};

  const handle = async (name, jid) => {
    if (resolver.lookup(jid).state === 'unknown') resolver.request(jid);
    dispatched[name] = Date.now();
  };

  const startedAt = Date.now();
  chain = chain.then(() => handle('first', PN(1)));
  chain = chain.then(() => handle('second', PN(2)));
  await chain;

  assert.ok(dispatched.second - startedAt < 100);
});

test('at most two lookups run at once and the rest wait their turn', async () => {
  let running = 0;
  let peak = 0;
  const resolver = resolverWith(
    async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(15);
      running--;
      return 'https://pps.whatsapp.net/photo';
    },
    { timeoutMs: 500 },
  );

  for (let n = 0; n < 6; n++) resolver.request(PN(n));
  assert.ok(resolver.stats().active <= 2);
  await sleep(150);

  assert.equal(peak, 2);
  assert.equal(resolver.stats().queued, 0);
  for (let n = 0; n < 6; n++) assert.equal(resolver.lookup(PN(n)).state, 'photo');
});

test('a resolved photo is cached for 24h and not queried again on every message', async () => {
  let now = 1_000;
  let calls = 0;
  const resolver = resolverWith(async () => (calls++, 'https://pps.whatsapp.net/a'), { now: () => now });

  resolver.request(PN(1));
  await sleep(10);
  assert.deepEqual({ ...resolver.lookup(PN(1)) }, { state: 'photo', url: 'https://pps.whatsapp.net/a' });

  for (let i = 0; i < 20; i++) assert.equal(resolver.request(PN(1)), false);
  assert.equal(calls, 1);

  now += 24 * 60 * 60 * 1000 - 1;
  assert.equal(resolver.lookup(PN(1)).state, 'photo');
  now += 1;
  assert.equal(resolver.lookup(PN(1)).state, 'unknown');
  assert.equal(resolver.request(PN(1)), true);
});

test('"no photo" and failures are cached negatively for different periods; transient errors are not cached', async () => {
  let now = 0;
  const outcomes = {
    [PN(1)]: () => Promise.resolve(null),
    [PN(2)]: () => Promise.reject(new Error('query failed')),
    [PN(3)]: () => Promise.reject(Object.assign(new Error('Connection Closed'), { transient: true })),
  };
  const reported = [];
  const resolver = resolverWith((jid) => outcomes[jid](), {
    now: () => now,
    isTransient: (error) => error.transient === true,
    onError: (jid) => reported.push(jid),
  });

  for (const n of [1, 2, 3]) resolver.request(PN(n));
  await sleep(20);

  assert.equal(resolver.lookup(PN(1)).state, 'none');
  assert.equal(resolver.lookup(PN(2)).state, 'none');
  assert.equal(resolver.lookup(PN(3)).state, 'unknown', 'a dropped connection says nothing about the contact');
  assert.deepEqual(reported.sort(), [PN(2), PN(3)].sort());

  now += 60 * 60 * 1000;
  assert.equal(resolver.lookup(PN(2)).state, 'unknown', 'failures are retried after an hour');
  assert.equal(resolver.lookup(PN(1)).state, 'none', 'an answer without photo is kept for longer');
  now += 5 * 60 * 60 * 1000;
  assert.equal(resolver.lookup(PN(1)).state, 'unknown');
});

test('concurrent requests for the same JID share one lookup and non-chat JIDs are never queried', async () => {
  const asked = [];
  const resolver = resolverWith(async (jid) => (asked.push(jid), null), { timeoutMs: 100 });

  assert.equal(resolver.request(PN(1)), true);
  assert.equal(resolver.request(PN(1)), false);
  for (const jid of ['status@broadcast', '12345@broadcast', '120363@newsletter', '', null]) {
    assert.equal(resolver.request(jid), false);
  }
  assert.equal(resolver.request('120363000000000000@g.us'), true);
  assert.equal(resolver.request('89900001111@lid'), true);

  await sleep(20);
  assert.deepEqual(asked.sort(), [PN(1), '120363000000000000@g.us', '89900001111@lid'].sort());
  assert.equal(isProfilePictureJid('status@broadcast'), false);
  assert.equal(isProfilePictureJid(PN(1)), true);
});

test('onResolved fires once per new photo and its failure never affects the cache', async () => {
  const resolved = [];
  const resolver = resolverWith(async () => 'https://pps.whatsapp.net/x', {
    onResolved: (jid, url) => {
      resolved.push([jid, url]);
      throw new Error('database unavailable');
    },
    onError: () => {},
  });

  resolver.request(PN(1));
  await sleep(10);
  resolver.request(PN(1));
  await sleep(10);

  assert.deepEqual(resolved, [[PN(1), 'https://pps.whatsapp.net/x']]);
  assert.equal(resolver.lookup(PN(1)).state, 'photo');
});

test('the waiting queue and the cache are bounded', async () => {
  const resolver = resolverWith(neverAnswers, { timeoutMs: 1_000, maxQueued: 3, maxEntries: 2, maxConcurrent: 1 });
  const accepted = [1, 2, 3, 4, 5, 6].map((n) => resolver.request(PN(n)));
  assert.deepEqual(accepted, [true, true, true, true, false, false]);
  resolver.clear();

  const small = resolverWith(async () => 'https://pps.whatsapp.net/y', { maxEntries: 2, maxConcurrent: 3 });
  for (const n of [1, 2, 3]) small.request(PN(n));
  await sleep(20);
  assert.equal(small.stats().cached, 2);
  assert.equal(small.lookup(PN(1)).state, 'unknown', 'the oldest entry was evicted');
});

test('clear() drops queued work and ignores lookups that were already in flight', async () => {
  let release;
  const resolver = resolverWith(
    () =>
      new Promise((done) => {
        release = () => done('https://pps.whatsapp.net/late');
      }),
    { timeoutMs: 1_000 },
  );
  resolver.request(PN(1));
  resolver.request(PN(2));
  resolver.clear();
  release();
  await sleep(20);

  assert.equal(resolver.lookup(PN(1)).state, 'unknown');
  assert.deepEqual(resolver.stats().queued, 0);
});

test('a failed photo lookup does not erase a photo that already exists', () => {
  const stored = { remoteJid: PN(1), pushName: 'Ana', instanceId: 'i1', profilePicUrl: 'https://pps.whatsapp.net/old' };

  for (const empty of [null, undefined, '']) {
    const update = omitEmptyPhoto({ ...stored, profilePicUrl: empty });
    assert.equal('profilePicUrl' in update, false, `${String(empty)} must not reach the UPDATE`);
    assert.equal(update.pushName, 'Ana');
  }

  assert.equal(omitEmptyPhoto({ ...stored, profilePicUrl: 'https://pps.whatsapp.net/new' }).profilePicUrl, 'https://pps.whatsapp.net/new');
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

test('messages.upsert never awaits WhatsApp for a profile picture', () => {
  const handler = between("'messages.upsert': async (", "'messages.update': async (");
  assert.doesNotMatch(handler, /await this\.profilePicture\(/);
  assert.match(handler, /this\.profilePictures\.lookup\(/);
  assert.match(handler, /this\.profilePictures\.request\(/);
});

test('every Baileys profilePictureUrl call carries an explicit timeout', () => {
  const calls = serviceSource.match(/this\.client\.profilePictureUrl\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 1);
  for (const call of calls) assert.match(call, /,[^,]+,[^,]+\)$/, `${call} has no timeout argument`);
});

test('no contact write can overwrite a stored photo with an empty value', () => {
  const upsertHandler = between("'messages.upsert': async (", "'messages.update': async (");
  assert.doesNotMatch(upsertHandler, /update: contactRaw/);
  assert.match(upsertHandler, /update: contactUpdate/);

  const contactHandlers = between("'contacts.upsert': async (", 'private normalizePhoneJid');
  assert.match(contactHandlers, /update: omitEmptyPhoto\(contact\)/);
  assert.match(contactHandlers, /SAVE_DATA\.CONTACTS && contact\.profilePicUrl/);
});

test('status@broadcast is skipped before any photo lookup instead of after it', () => {
  const handler = between("'messages.upsert': async (", "'messages.update': async (");
  const statusSkip = handler.indexOf("received.key.remoteJid === 'status@broadcast'");
  const lookup = handler.indexOf('this.profilePictures.lookup(');
  assert.ok(statusSkip > 0 && lookup > statusSkip);
});
