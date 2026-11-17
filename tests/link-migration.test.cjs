// The LinkToken table must stay purely additive and identical across the three Prisma schemas and both providers'
// migrations. These checks are static (no database): they catch a schema edited in one place only (psql_bouncer already
// drifted once) and any migration step that touches a table that existed before.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const SCHEMAS = ['postgresql', 'mysql', 'psql_bouncer'].map((name) => `prisma/${name}-schema.prisma`);
const MIGRATIONS = {
  postgresql: 'prisma/postgresql-migrations/20261006120000_add_link_token/migration.sql',
  mysql: 'prisma/mysql-migrations/20261006120000_add_link_token/migration.sql',
};

const modelBlock = (schema) => {
  const start = schema.indexOf('model LinkToken {');
  assert.notEqual(start, -1, 'model LinkToken is missing');
  return schema.slice(start, schema.indexOf('\n}\n', start) + 3);
};

test('all three schemas define the same LinkToken model and the Instance back-relation', () => {
  const blocks = SCHEMAS.map((file) => modelBlock(read(file)));
  assert.equal(blocks[1], blocks[0]);
  assert.equal(blocks[2], blocks[0]);
  for (const file of SCHEMAS) assert.match(read(file), /\n {2}LinkToken {15}LinkToken\[\]\n\}/);
  assert.match(blocks[0], /onDelete: Cascade/);
  assert.match(blocks[0], /tokenHash {7}String {4}@unique @db\.VarChar\(64\)/);
});

test('the model never stores the token itself, an IP address or the phone number being linked', () => {
  const columns = [...modelBlock(read(SCHEMAS[0])).matchAll(/^ {2}(\w+) /gm)].map((match) => match[1]);
  for (const forbidden of ['token', 'ip', 'ipAddress', 'phone', 'number', 'pairingCode']) {
    assert.ok(!columns.includes(forbidden), `LinkToken must not have a "${forbidden}" column`);
  }
  assert.ok(columns.includes('tokenHash'));
  assert.ok(columns.includes('expectedNumber'), 'only the admin-supplied expected number is stored');
});

for (const [provider, file] of Object.entries(MIGRATIONS)) {
  test(`${provider} migration only creates the LinkToken table, its indexes and its foreign key`, () => {
    const sql = read(file);
    const statements = sql
      .split(';')
      .map((statement) =>
        statement
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter(Boolean);
    assert.equal(statements.length, 2 + (provider === 'postgresql' ? 2 : 0), 'unexpected number of statements');
    assert.ok(statements.every((statement) => /LinkToken/.test(statement)), 'every statement must target LinkToken');
    // "ON DELETE CASCADE" / "ON UPDATE CASCADE" are part of the foreign key; data-changing statements are not allowed.
    assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|RENAME)\b|\bINSERT\s+INTO\b|\bDELETE\s+FROM\b|\bUPDATE\s+[`"\w]+\s+SET\b/i);
    assert.doesNotMatch(sql, /ALTER TABLE\s+[`"](?!LinkToken)/);
    assert.match(sql, /CREATE TABLE [`"]LinkToken[`"]/);
    assert.match(sql, /FOREIGN KEY \([`"]instanceId[`"]\) REFERENCES [`"]Instance[`"]\([`"]id[`"]\) ON DELETE CASCADE/);
    assert.match(sql, /UNIQUE INDEX [`"]LinkToken_tokenHash_key[`"]/);
  });

  test(`${provider} migration declares every column of the model`, () => {
    const columns = [...modelBlock(read(SCHEMAS[0])).matchAll(/^ {2}(\w+) +(\w+)/gm)]
      .filter(([, , type]) => type !== 'LinkToken' && !/^Instance$/.test(type))
      .map(([, name]) => name);
    const sql = read(file);
    for (const column of columns) assert.match(sql, new RegExp(`[\`"]${column}[\`"]`), `${column} missing from ${provider} SQL`);
  });
}

test('the new migration sorts after every existing one and the lock files are untouched', () => {
  for (const provider of ['postgresql', 'mysql']) {
    const folders = fs
      .readdirSync(path.join(root, `prisma/${provider}-migrations`))
      .filter((name) => /^\d{14}_/.test(name))
      .sort();
    assert.equal(folders.at(-1), '20261006120000_add_link_token');
  }
});
