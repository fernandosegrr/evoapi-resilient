const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

// The Baileys service needs a live WhatsApp socket, so the rules that keep the per-instance event chain moving
// are pinned structurally against its source. Each one exists because a slow step in that chain delays every
// following message of the instance (see docs/validation/webhook-delivery-delay-2026-10-06.md).
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

test('webhook sends inside the event chain are never awaited (a down receiver must not hold the chain)', () => {
  // The only awaited send is the one inside the dedicated webhook lane (its own queue, 5s timeout, 3 attempts).
  const lane = serviceSource.slice(
    serviceSource.indexOf('private enqueueMessageWebhook('),
    serviceSource.indexOf('private async claimIncomingMessage'),
  );
  assert.equal((lane.match(/await this\.sendDataWebhook\(/g) ?? []).length, 1);
  assert.doesNotMatch(serviceSource.replace(lane, ''), /await this\.sendDataWebhook\(/);
});

test('the MESSAGES_EDITED webhook is dispatched without await and its failure is handled', () => {
  const handler = between("'messages.upsert': async (", "'messages.update': async (");
  const statement = handler.slice(handler.indexOf('this.sendDataWebhook(Events.MESSAGES_EDITED'));

  assert.ok(handler.includes('this.sendDataWebhook(Events.MESSAGES_EDITED'));
  assert.match(statement.slice(0, 400), /\)\.catch\(\(error\) =>/);
  assert.ok(
    handler.indexOf('this.sendDataWebhook(Events.MESSAGES_EDITED') < handler.indexOf('await this.baileysCache.set('),
    'the rest of the edit handling follows immediately',
  );
});

test('the whole message is never printed to stdout (base64 media included) on every message', () => {
  assert.doesNotMatch(serviceSource, /console.log(messageRaw)/);
});
