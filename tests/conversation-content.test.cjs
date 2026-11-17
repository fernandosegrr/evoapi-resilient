const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/ts-loader.cjs');
const { getConversationMessage: content } = loadTs('src/utils/getConversationMessage.ts', {
  '@config/env.config': { configService: { get: () => ({ ENABLE: false }) } },
});
const fixture = (message) => ({ key: { id: 'fixture-id' }, message });
test('Meta Ads nested context appends body or title using the existing ad delimiter', () => {
  assert.equal(
    content(fixture({ extendedTextMessage: { text: 'Hola', contextInfo: { externalAdReply: { body: 'Oferta' } } } })),
    'Hola\nexternalAdReplyBody|Oferta',
  );
  assert.equal(
    content(fixture({ extendedTextMessage: { contextInfo: { externalAdReply: { title: 'Solo título' } } } })),
    'externalAdReplyBody|Solo título',
  );
  assert.equal(
    content({ message: { conversation: 'Hola' }, contextInfo: { externalAdReply: { body: 'Existing' } } }),
    'Hola\nexternalAdReplyBody|Existing',
  );
});
test('locations without latitude and unknown or absent content produce an empty string', () => {
  for (const msg of [
    undefined,
    {},
    fixture({}),
    fixture({ locationMessage: {} }),
    fixture({ futureMessage: { value: 'ignored' } }),
  ]) {
    assert.equal(content(msg), '');
  }
  assert.equal(content(fixture({ locationMessage: { degreesLatitude: 0 } })), '0');
  assert.equal(content(fixture({ locationMessage: { degreesLatitude: 19.4 } })), '19.4');
});
test('normal bot text, contacts, responses and media keep the current payload contract', () => {
  const cases = [
    [{ conversation: 'Texto' }, 'Texto'],
    [{ extendedTextMessage: { text: 'Extendido' } }, 'Extendido'],
    [{ contactMessage: { displayName: 'Contacto' } }, 'Contacto'],
    [{ listResponseMessage: { title: 'Elegido' } }, 'Elegido'],
    [{ templateButtonReplyMessage: { selectedId: 'button-1' } }, 'button-1'],
    [{ imageMessage: { caption: 'Foto' } }, 'imageMessage|fixture-id|Foto'],
    [{ audioMessage: {} }, 'audioMessage|fixture-id'],
    [{ videoMessage: {} }, 'videoMessage|fixture-id'],
    [{ documentMessage: { caption: 'Documento' } }, 'documentMessage|fixture-id|Documento'],
    [{ speechToText: 'Voz', audioMessage: {} }, 'Voz'],
  ];
  for (const [message, expected] of cases) assert.equal(content(fixture(message)), expected);
});
