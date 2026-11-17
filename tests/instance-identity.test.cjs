const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const express = require('express');
const { loadTs } = require('./helpers/ts-loader.cjs');
class Logger {
  error() {}
  warn() {}
}
class UnauthorizedException extends Error {}
const { RouterBroker } = loadTs('src/api/abstract/abstract.router.ts', {
  '@config/logger.config': { Logger },
  '@exceptions': { BadRequestException: Error },
});
const tenants = {
  a: { name: 'a', id: 'id-a', token: 'synthetic-a' },
  b: { name: 'b', id: 'id-b', token: 'synthetic-b' },
};
const { authGuard } = loadTs('src/api/guards/auth.guard.ts', {
  '@api/server.module': {
    prismaRepository: {
      instance: {
        findUnique: async ({ where }) => tenants[where.name],
        findFirst: async ({ where }) => Object.values(tenants).find((row) => row.token === where.token),
      },
    },
  },
  '@config/env.config': {
    configService: {
      get: (name) =>
        name === 'AUTHENTICATION' ? { API_KEY: { KEY: 'synthetic-global' } } : { SAVE_DATA: { INSTANCE: true } },
    },
  },
  '@config/logger.config': { Logger },
  '@exceptions': { ForbiddenException: Error, UnauthorizedException },
});
const broker = new RouterBroker();
class Payload {}
async function run(t, methodName = 'dataValidate') {
  const app = express();
  app.use(express.json());
  app.post('/operate/:instanceName', authGuard.apikey, async (req, res) => {
    const value = await broker[methodName]({
      request: req,
      ClassRef: Payload,
      schema: { type: 'object' },
      execute: async (instance, data) => ({ instance, data, params: req.params }),
    });
    res.json(value);
  });
  app.use((err, req, res, next) =>
    res.status(err instanceof UnauthorizedException ? 401 : 400).json({ error: err.name }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (route, key = 'synthetic-a', body = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/operate/` + route, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
}
test('real HTTP auth and shared dataValidate protect tenant identity against query, body and URL spoofing', async (t) => {
  const call = await run(t);
  for (const query of ['instanceName=b&instanceId=id-b', 'marker=/instance/create', 'instanceName[]=b']) {
    const r = await call('a?' + query, 'synthetic-a', { instanceName: 'b', instanceId: 'id-b', text: 'normal' });
    assert.equal(r.status, 200);
    assert.equal(r.body.instance.instanceName, 'a');
    assert.equal(r.body.instance.instanceId, undefined);
    assert.equal(r.body.data.instanceName, undefined);
    assert.equal(r.body.data.instanceId, undefined);
    assert.equal(r.body.data.text, 'normal');
    assert.equal(r.body.params.instanceName, 'a');
  }
  assert.equal((await call('b')).status, 401);
  assert.equal((await call('b', 'synthetic-global')).body.instance.instanceName, 'b');
});
for (const method of ['groupNoValidate', 'groupValidate', 'inviteCodeValidate', 'getParticipantsValidate']) {
  test(`${method} strips identity from untrusted data and retains authenticated route params`, async (t) => {
    const call = await run(t, method);
    const r = await call(
      'a?instanceName=b&instanceId=id-b&inviteCode=fixture&getParticipants=true&groupJid=123@g.us',
      'synthetic-a',
      { instanceName: 'b', instanceId: 'id-b', groupJid: '123@g.us' },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.instance.instanceName, 'a');
    assert.equal(r.body.data.instanceName, undefined);
    assert.equal(r.body.data.instanceId, undefined);
    assert.equal(
      (await call('b?inviteCode=fixture&getParticipants=true', 'synthetic-global', { groupJid: '123@g.us' })).body
        .instance.instanceName,
      'b',
    );
  });
}
test('prototype properties cannot restore a protected identity through inheritance', async () => {
  const request = {
    params: { instanceName: 'a' },
    body: JSON.parse('{"__proto__":{"instanceName":"b"}}'),
    query: JSON.parse('{"__proto__":{"instanceId":"id-b"}}'),
    originalUrl: '/operate/a',
    method: 'POST',
  };
  const result = await broker.dataValidate({
    request,
    ClassRef: Payload,
    schema: null,
    execute: async (instance, data) => ({ instance, data }),
  });
  assert.equal(result.instance.instanceName, 'a');
  assert.equal(result.instance.instanceId, undefined);
  assert.equal(result.data.instanceName, undefined);
});
test('a tenant token cannot authorize creation by placing fetchInstances in query text', async () => {
  const req = { originalUrl: '/instance/create?marker=/instance/fetchInstances', params: {}, get: () => 'synthetic-a' };
  await assert.rejects(
    authGuard.apikey(req, {}, () => {}),
    UnauthorizedException,
  );
});
