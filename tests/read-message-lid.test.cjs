const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

test('read receipts include PN, group and LID keys, excluding broadcasts and newsletters', async () => {
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
  const method = cls.members.find((n) => n.name?.getText(source) === 'markMessageAsRead').getText(source);
  const code = ts.transpileModule(`class Subject { ${method} }; module.exports=Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const baileys = await import('baileys');
  vm.runInNewContext(code, { module, ...baileys, InternalServerErrorException: Error });
  const subject = new module.exports();
  let keys;
  subject.client = {
    readMessages: async (value) => {
      keys = value;
    },
  };
  const readMessages = [
    '5215551234567@s.whatsapp.net',
    '120363000000@g.us',
    '123456789012345@lid',
    'status@broadcast',
    '123@broadcast',
    '123@newsletter',
  ].map((remoteJid, i) => ({ remoteJid, fromMe: false, id: `fixture-${i}` }));
  const result = await subject.markMessageAsRead({ readMessages });
  assert.deepEqual(JSON.parse(JSON.stringify(keys)), readMessages.slice(0, 3));
  assert.equal(result.read, 'success');
  subject.client.readMessages = async () => {
    throw Error('synthetic transport failure');
  };
  await assert.rejects(subject.markMessageAsRead({ readMessages }), /Read messages fail/);
});
