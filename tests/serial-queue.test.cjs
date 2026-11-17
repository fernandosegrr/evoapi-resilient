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

const { SerialQueue } = load('src/utils/serialQueue.ts');
const deadline = load('src/utils/deadline.ts');
const { ProfilePictureResolver } = load('src/utils/profilePictureResolver.ts', { '@utils/deadline': deadline });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const neverAnswers = () => new Promise(() => {});

test('tasks run strictly one at a time and in the order they were enqueued', async () => {
  const queue = new SerialQueue();
  const log = [];
  let running = 0;
  let peak = 0;

  const task = (name, ms) => async () => {
    running++;
    peak = Math.max(peak, running);
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    running--;
    return name;
  };

  const results = await Promise.all([queue.enqueue(task('a', 30)), queue.enqueue(task('b', 5)), queue.enqueue(task('c', 1))]);

  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.equal(peak, 1);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('a failing task rejects only its own promise and the queue carries on', async () => {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    const queue = new SerialQueue();
    const failed = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const next = queue.enqueue(async () => 'still running');

    await assert.rejects(failed, /boom/);
    assert.equal(await next, 'still running');
    await sleep(10);
    assert.deepEqual(unhandled, []);
    assert.equal(queue.depth, 0);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('a synchronous throw inside a task is treated like any other failure', async () => {
  const queue = new SerialQueue();
  const failed = queue.enqueue(() => {
    throw new Error('sync boom');
  });
  const next = queue.enqueue(() => 'ok');

  await assert.rejects(failed, /sync boom/);
  assert.equal(await next, 'ok');
});

test('depth counts the waiting tasks plus the running one and returns to zero', async () => {
  const queue = new SerialQueue();
  assert.equal(queue.depth, 0);

  let release;
  const first = queue.enqueue(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const second = queue.enqueue(() => 'two');
  const third = queue.enqueue(() => 'three');
  assert.equal(queue.depth, 3);

  await sleep(5); // the first task starts on the next tick
  release();
  await Promise.all([first, second, third]);
  assert.equal(queue.depth, 0);
});

test('onWait reports how long each task waited behind the ones before it', async () => {
  const waits = [];
  const queue = new SerialQueue({ onWait: (ms) => waits.push(ms) });

  const slow = queue.enqueue(() => sleep(80));
  const waiting = queue.enqueue(() => 'x');
  await Promise.all([slow, waiting]);

  assert.equal(waits.length, 2);
  assert.ok(waits[0] < 30, `the first task waits for nobody (${waits[0]}ms)`);
  assert.ok(waits[1] >= 60, `the second waited for the slow one (${waits[1]}ms)`);
});

test('a throwing onWait observer never affects the queue', async () => {
  const queue = new SerialQueue({
    onWait: () => {
      throw new Error('observer bug');
    },
  });
  assert.equal(await queue.enqueue(() => 'fine'), 'fine');
  assert.equal(queue.depth, 0);
});

// ---- the production topology: event chain -> contact step -> single webhook lane ----------------------------

function messageHandler({ resolver, webhookLane, dispatched, awaitPhoto, photoDeadlineMs }) {
  return async (n) => {
    const jid = `5214620000${String(n).padStart(3, '0')}@s.whatsapp.net`;
    // the webhook is queued first, exactly as in messages.upsert
    void webhookLane.enqueue(async () => {
      dispatched.push({ n, at: Date.now() });
    });

    if (awaitPhoto) {
      // legacy behaviour: wait for the photo query (it never answers, so only the deadline releases it)
      await deadline.withDeadline(neverAnswers(), photoDeadlineMs).catch(() => undefined);
    } else if (resolver.lookup(jid).state === 'unknown') {
      resolver.request(jid);
    }
  };
}

async function runBurst({ count, awaitPhoto }) {
  const eventChain = new SerialQueue();
  const webhookLane = new SerialQueue();
  const resolver = new ProfilePictureResolver({ fetchUrl: neverAnswers, timeoutMs: 400 });
  const dispatched = [];
  const handle = messageHandler({ resolver, webhookLane, dispatched, awaitPhoto, photoDeadlineMs: 120 });

  const startedAt = Date.now();
  const handled = [];
  for (let n = 0; n < count; n++) handled.push(eventChain.enqueue(() => handle(n)));
  await Promise.all(handled);
  await webhookLane.enqueue(() => undefined);

  const gaps = dispatched.slice(1).map((entry, i) => entry.at - dispatched[i].at);
  return { dispatched, gaps, totalMs: Date.now() - startedAt, resolver };
}

test('a burst of 10 messages is dispatched without gaps close to a photo timeout', async () => {
  const { dispatched, gaps, totalMs, resolver } = await runBurst({ count: 10, awaitPhoto: false });

  assert.deepEqual(dispatched.map((entry) => entry.n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'order is preserved');
  assert.ok(Math.max(...gaps) < 60, `largest gap ${Math.max(...gaps)}ms`);
  assert.ok(totalMs < 120, `burst took ${totalMs}ms`);
  resolver.clear();
});

test('control: awaiting the photo query inside the chain (the old behaviour) spaces webhooks by the query timeout', async () => {
  const { gaps } = await runBurst({ count: 4, awaitPhoto: true });

  assert.ok(Math.min(...gaps) >= 100, `with the old behaviour every gap is about the 120ms deadline (${gaps})`);
});
