// Pure building blocks of the self-service link: token, phone numbers, client IP, rate limiter and configuration.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadTs, root } = require('./helpers/ts-loader.cjs');

// Objects built inside the vm context have another Object.prototype: compare them as plain JSON.
const deepEqual = (actual, expected, message) =>
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const token = loadTs('src/utils/linkToken.ts');
const phone = loadTs('src/utils/linkPhone.ts');
const { resolveClientIp } = loadTs('src/utils/clientIp.ts');
const { SlidingWindowLimiter } = loadTs('src/utils/rateLimiter.ts');

// ------------------------------------------------------------------------------------------------ token

test('tokens are 256 random bits as 43 base64url characters and never repeat', () => {
  const seen = new Set();
  for (let index = 0; index < 2000; index++) {
    const value = token.generateLinkToken();
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(value, 'base64url').length, 32);
    assert.ok(token.isWellFormedLinkToken(value));
    seen.add(value);
  }
  assert.equal(seen.size, 2000);
});

test('the stored hash is the SHA-256 of the token (known vector) and differs per token', () => {
  assert.equal(token.hashLinkToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const a = token.generateLinkToken();
  const b = token.generateLinkToken();
  assert.match(token.hashLinkToken(a), /^[0-9a-f]{64}$/);
  assert.equal(token.hashLinkToken(a), createHash('sha256').update(a).digest('hex'));
  assert.notEqual(token.hashLinkToken(a), token.hashLinkToken(b));
});

test('malformed tokens are rejected before any lookup', () => {
  const good = token.generateLinkToken();
  for (const bad of [
    undefined,
    null,
    42,
    {},
    [good],
    '',
    good.slice(1),
    `${good}A`,
    `${good.slice(0, 42)}=`,
    ` ${good.slice(1)}`,
    `${good.slice(0, 42)}+`,
    `${good.slice(0, 42)}/`,
    `${good.slice(0, 42)}\n`,
    `${good.slice(0, 42)}é`,
  ]) {
    assert.equal(token.isWellFormedLinkToken(bad), false, JSON.stringify(bad));
  }
});

test('hash comparison is exact and tolerant of garbage', () => {
  const hash = token.hashLinkToken('x');
  assert.equal(token.hashesEqual(hash, hash), true);
  assert.equal(token.hashesEqual(hash, token.hashLinkToken('y')), false);
  assert.equal(token.hashesEqual(hash, hash.slice(2)), false);
  assert.equal(token.hashesEqual(hash, 'z'.repeat(64)), false);
  assert.equal(token.hashesEqual('', ''), false);
  assert.equal(token.hashesEqual(undefined, hash), false);
});

test('link state is derived with the priority revoked > consumed > expired > active', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const future = new Date(now + 1000);
  const past = new Date(now - 1000);
  const state = (times) => token.linkTokenState(times, now);
  assert.equal(state({ expiresAt: future }), 'active');
  assert.equal(state({ expiresAt: new Date(now) }), 'expired', 'expiring exactly now is already expired');
  assert.equal(state({ expiresAt: past }), 'expired');
  assert.equal(state({ expiresAt: future, consumedAt: past }), 'consumed');
  assert.equal(state({ expiresAt: past, consumedAt: past }), 'consumed');
  assert.equal(state({ expiresAt: future, revokedAt: past }), 'revoked');
  assert.equal(state({ expiresAt: future, consumedAt: past, revokedAt: past }), 'revoked');
});

test('only active links and recently consumed ones are readable by the public endpoints', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const future = new Date(now + 60_000);
  const past = new Date(now - 60_000);
  const readable = (times) => token.isLinkTokenReadable(times, now);
  assert.equal(readable({ expiresAt: future }), true);
  assert.equal(readable({ expiresAt: past }), false);
  assert.equal(readable({ expiresAt: future, revokedAt: past }), false);
  assert.equal(readable({ expiresAt: future, consumedAt: new Date(now - 14 * 60_000) }), true);
  assert.equal(readable({ expiresAt: future, consumedAt: new Date(now - token.CONSUMED_GRACE_MS) }), true);
  assert.equal(readable({ expiresAt: future, consumedAt: new Date(now - token.CONSUMED_GRACE_MS - 1) }), false);
  assert.equal(readable({ expiresAt: future, consumedAt: past, revokedAt: past }), false);
});

// ------------------------------------------------------------------------------------------------ phone numbers

test('phone input: accepts what people type, rejects everything ambiguous', () => {
  const ok = (input) => phone.parseLinkPhone(input);
  deepEqual(ok('+52 462 123 4567'), { ok: true, digits: '524621234567' });
  deepEqual(ok('52-462-123-4567'), { ok: true, digits: '524621234567' });
  deepEqual(ok('+52 (462) 123 4567'), { ok: true, digits: '524621234567' });
  deepEqual(ok('  5214621234567 '), { ok: true, digits: '5214621234567' });
  deepEqual(ok('+52 462 123 4567\n'), { ok: true, digits: '524621234567' }); // surrounding whitespace is trimmed
  deepEqual(ok('+14155552671'), { ok: true, digits: '14155552671' });

  for (const bad of [
    undefined,
    null,
    5214621234567,
    [],
    '',
    '   ',
    'abc',
    '52 462 123 456x',
    '+52+462 123 4567',
    '52 462 123 4567+',
    '++524621234567',
    '5246212345 ext 12',
    '524621234567#12',
    '52.462.123.4567',
    '+0524621234567',
    '0524621234567',
    '1234567', // 7 digits
    '1234567890123456', // 16 digits
    '+52 462\n123 4567',
    '+52\t462 123 4567',
    '５２４６２１２３４５６７', // full-width digits
    '+'.padEnd(40, '5'),
  ]) {
    deepEqual(ok(bad), { ok: false, reason: 'invalid_number' }, JSON.stringify(bad));
  }
});

test('Mexican numbers are normalised to the configured prefix; other countries pass through', () => {
  const to = (digits, prefix) => phone.toPairingNumber(digits, prefix);
  deepEqual(to('524621234567', '52'), { ok: true, digits: '524621234567' });
  deepEqual(to('5214621234567', '52'), { ok: true, digits: '524621234567' });
  deepEqual(to('524621234567', '521'), { ok: true, digits: '5214621234567' });
  deepEqual(to('5214621234567', '521'), { ok: true, digits: '5214621234567' });
  deepEqual(to('14155552671', '52'), { ok: true, digits: '14155552671' });
  deepEqual(to('5491155551234', '521'), { ok: true, digits: '5491155551234' });
  // 52 is Mexico only, so a wrong length cannot be another country's number.
  for (const digits of ['52462123456', '52462123456789', '5254621234567', '52']) {
    deepEqual(to(digits, '52'), { ok: false, reason: 'invalid_number' }, digits);
  }
});

test('52 and 521 are the same Mexican line, everything else must match exactly', () => {
  assert.equal(phone.equivalentNumbers('5214621234567', '524621234567'), true);
  assert.equal(phone.equivalentNumbers('524621234567', '524621234567'), true);
  assert.equal(phone.equivalentNumbers('5214621234567', '5214621234567'), true);
  assert.equal(phone.equivalentNumbers('524621234567', '524621234568'), false);
  assert.equal(phone.equivalentNumbers('14155552671', '14155552671'), true);
  assert.equal(phone.equivalentNumbers('14155552671', '14155552672'), false);
  assert.equal(phone.equivalentNumbers('', ''), false);
  assert.equal(phone.equivalentNumbers('5491155551234', '541155551234'), false);
});

test('only phone JIDs yield digits; the device suffix is dropped', () => {
  assert.equal(phone.jidToDigits('5214620000003@s.whatsapp.net'), '5214620000003');
  assert.equal(phone.jidToDigits('5214620000003:12@s.whatsapp.net'), '5214620000003');
  for (const bad of ['70000000000001@lid', '120363@g.us', 'status@broadcast', '', undefined, 5, '5214620000003']) {
    assert.equal(phone.jidToDigits(bad), '', String(bad));
  }
});

test('masked numbers show the last four digits and never the national prefix', () => {
  assert.equal(phone.maskNumber('524621234567'), '+52 ••• ••• 4567');
  assert.equal(phone.maskNumber('5214621234567'), '+52 ••• ••• 4567');
  assert.equal(phone.maskNumber('14155552671'), '+•• ••• ••• 2671');
  assert.equal(phone.maskNumber(''), '');
  assert.equal(phone.lastFour('524621234567'), '4567');
});

// ------------------------------------------------------------------------------------------------ client IP

test('client IP: the hops-th entry from the right of X-Forwarded-For, never what the client prepended', () => {
  const ip = (xff, peer, hops) => resolveClientIp(xff, peer, hops);
  deepEqual(ip('203.0.113.9', '10.0.0.2', 1), { ip: '203.0.113.9', source: 'forwarded' });
  deepEqual(ip('6.6.6.6, 203.0.113.9', '10.0.0.2', 1), { ip: '203.0.113.9', source: 'forwarded' });
  deepEqual(ip('6.6.6.6, 203.0.113.9, 172.16.0.5', '10.0.0.2', 2), { ip: '203.0.113.9', source: 'forwarded' });
  deepEqual(ip(['6.6.6.6', '203.0.113.9'], '10.0.0.2', 1), { ip: '203.0.113.9', source: 'forwarded' });
  deepEqual(ip('  203.0.113.9  ', '10.0.0.2', 1), { ip: '203.0.113.9', source: 'forwarded' });
  deepEqual(ip('2001:db8::1', '10.0.0.2', 1), { ip: '2001:db8::1', source: 'forwarded' });
  deepEqual(ip('::ffff:203.0.113.9', '10.0.0.2', 1), { ip: '203.0.113.9', source: 'forwarded' });
});

test('client IP: falls back to the TCP peer when the proxy chain is not what was configured', () => {
  const ip = (xff, peer, hops) => resolveClientIp(xff, peer, hops);
  deepEqual(ip('203.0.113.9', '10.0.0.2', 0), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip('203.0.113.9', '10.0.0.2', -1), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip('203.0.113.9', '10.0.0.2', Number.NaN), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip(undefined, '10.0.0.2', 1), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip('', '10.0.0.2', 1), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip('203.0.113.9', '10.0.0.2', 2), { ip: '10.0.0.2', source: 'socket' }, 'fewer entries than hops');
  deepEqual(ip('not-an-ip', '10.0.0.2', 1), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip('203.0.113.9, <script>', '10.0.0.2', 1), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip(undefined, '::ffff:10.0.0.2', 1), { ip: '10.0.0.2', source: 'socket' });
  deepEqual(ip(undefined, undefined, 1), { ip: 'unknown', source: 'socket' });
});

// ------------------------------------------------------------------------------------------------ rate limiter

function limiter(options = {}) {
  const clock = { now: 1_000_000 };
  const instance = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, maxKeys: 100, now: () => clock.now, ...options });
  return { clock, instance };
}

test('sliding window: allows up to the limit, then says how long to wait', () => {
  const { clock, instance } = limiter();
  deepEqual(instance.hit('a'), { allowed: true, remaining: 2, retryAfterMs: 0 });
  clock.now += 10_000;
  assert.equal(instance.hit('a').allowed, true);
  clock.now += 10_000;
  assert.equal(instance.hit('a').remaining, 0);
  clock.now += 10_000;
  const denied = instance.hit('a');
  deepEqual(denied, { allowed: false, remaining: 0, retryAfterMs: 30_000 });
  clock.now += 30_000;
  assert.equal(instance.hit('a').allowed, true, 'the oldest hit slid out of the window');
});

test('sliding window: keys are independent, peek never counts and record always counts', () => {
  const { clock, instance } = limiter({ limit: 2 });
  instance.hit('a');
  instance.hit('a');
  assert.equal(instance.hit('a').allowed, false);
  assert.equal(instance.hit('b').allowed, true);
  assert.equal(instance.peek('b').remaining, 1);
  assert.equal(instance.peek('b').remaining, 1);
  instance.record('c');
  instance.record('c');
  instance.record('c');
  assert.equal(instance.peek('c').allowed, false, 'failures accumulate past the limit');
  clock.now += 60_000;
  assert.equal(instance.peek('c').allowed, true);
});

test('sliding window: memory is bounded by maxKeys even under a flood of distinct keys', () => {
  const { instance } = limiter({ maxKeys: 50 });
  for (let index = 0; index < 5000; index++) instance.hit(`198.51.100.${index}`);
  assert.ok(instance.size <= 50, `tracked ${instance.size} keys`);
});

test('sliding window: sweep drops expired keys', () => {
  const { clock, instance } = limiter();
  for (let index = 0; index < 10; index++) instance.hit(`k${index}`);
  assert.equal(instance.size, 10);
  clock.now += 61_000;
  instance.sweep();
  assert.equal(instance.size, 0);
});

// ------------------------------------------------------------------------------------------------ configuration

const LINK_ENV = [
  'LINK_PUBLIC_ENABLED',
  'LINK_PUBLIC_BASE_URL',
  'LINK_TOKEN_DEFAULT_TTL_HOURS',
  'LINK_TOKEN_MAX_TTL_HOURS',
  'LINK_ATTEMPTS_PER_HOUR',
  'LINK_ATTEMPTS_PER_TOKEN',
  'LINK_MAX_AUTO_RESETS',
  'LINK_RESET_AFTER_SECONDS',
  'LINK_ATTEMPT_TTL_SECONDS',
  'LINK_TRUST_PROXY_HOPS',
  'LINK_PAIRING_MX_PREFIX',
];
const { ConfigService } = loadTs('src/config/env.config.ts', { dotenv: { config() {} } });
function linkConfig(env = {}) {
  const saved = Object.fromEntries(LINK_ENV.map((key) => [key, process.env[key]]));
  for (const key of LINK_ENV) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return new ConfigService().get('LINK');
  } finally {
    for (const key of LINK_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('config defaults: public surface off, conservative limits, provisional 52 prefix', () => {
  deepEqual(JSON.parse(JSON.stringify(linkConfig())), {
    PUBLIC_ENABLED: false,
    PUBLIC_BASE_URL: null,
    TOKEN_DEFAULT_TTL_HOURS: 24,
    TOKEN_MAX_TTL_HOURS: 168,
    ATTEMPTS_PER_HOUR: 6,
    ATTEMPTS_PER_TOKEN: 12,
    MAX_AUTO_RESETS: 2,
    RESET_AFTER_SECONDS: 120,
    ATTEMPT_TTL_SECONDS: 600,
    TRUST_PROXY_HOPS: 1,
    PAIRING_MX_PREFIX: '52',
  });
});

test('config: only the exact string "true" enables the public surface', () => {
  assert.equal(linkConfig({ LINK_PUBLIC_ENABLED: 'true' }).PUBLIC_ENABLED, true);
  for (const value of ['TRUE', '1', 'yes', 'on', ' true', 'false', '']) {
    assert.equal(linkConfig({ LINK_PUBLIC_ENABLED: value }).PUBLIC_ENABLED, false, value);
  }
});

test('config: numbers fall back on garbage and are clamped, a link never lives more than 7 days', () => {
  assert.equal(linkConfig({ LINK_TOKEN_DEFAULT_TTL_HOURS: '99999' }).TOKEN_DEFAULT_TTL_HOURS, 168);
  assert.equal(linkConfig({ LINK_TOKEN_MAX_TTL_HOURS: '99999' }).TOKEN_MAX_TTL_HOURS, 168);
  assert.equal(linkConfig({ LINK_TOKEN_DEFAULT_TTL_HOURS: '0' }).TOKEN_DEFAULT_TTL_HOURS, 1);
  assert.equal(linkConfig({ LINK_RESET_AFTER_SECONDS: '5' }).RESET_AFTER_SECONDS, 30);
  assert.equal(linkConfig({ LINK_RESET_AFTER_SECONDS: '99999' }).RESET_AFTER_SECONDS, 600);
  assert.equal(linkConfig({ LINK_RESET_AFTER_SECONDS: 'abc' }).RESET_AFTER_SECONDS, 120);
  assert.equal(linkConfig({ LINK_MAX_AUTO_RESETS: '0' }).MAX_AUTO_RESETS, 0, '0 turns the automatic reset off');
  assert.equal(linkConfig({ LINK_MAX_AUTO_RESETS: '-3' }).MAX_AUTO_RESETS, 0);
  assert.equal(linkConfig({ LINK_MAX_AUTO_RESETS: '500' }).MAX_AUTO_RESETS, 10);
  assert.equal(linkConfig({ LINK_ATTEMPTS_PER_HOUR: '0' }).ATTEMPTS_PER_HOUR, 1);
  assert.equal(linkConfig({ LINK_TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS, 0);
  assert.equal(linkConfig({ LINK_TRUST_PROXY_HOPS: '99' }).TRUST_PROXY_HOPS, 5);
});

test('config: the Mexican prefix is 52 unless the legacy 521 is chosen explicitly', () => {
  assert.equal(linkConfig({ LINK_PAIRING_MX_PREFIX: '521' }).PAIRING_MX_PREFIX, '521');
  assert.equal(linkConfig({ LINK_PAIRING_MX_PREFIX: '52' }).PAIRING_MX_PREFIX, '52');
  for (const value of ['5', '5211', 'abc', '']) assert.equal(linkConfig({ LINK_PAIRING_MX_PREFIX: value }).PAIRING_MX_PREFIX, '52', value);
});

test('config: LINK_PUBLIC_BASE_URL must be a bare http(s) origin', () => {
  const base = (value) => linkConfig({ LINK_PUBLIC_BASE_URL: value }).PUBLIC_BASE_URL;
  assert.equal(base('https://links.example.com'), 'https://links.example.com');
  assert.equal(base('https://links.example.com/'), 'https://links.example.com');
  assert.equal(base(' http://localhost:8080 '), 'http://localhost:8080');
  for (const bad of [
    'https://links.example.com/manager',
    'https://links.example.com/?a=1',
    'https://links.example.com/#x',
    'https://user:pw@links.example.com',
    'ftp://links.example.com',
    'javascript:alert(1)',
    'not a url',
    '//links.example.com',
    '',
  ]) {
    assert.equal(base(bad), null, bad);
  }
});

test('the defaults documented in .env.example are the ones the code uses (it becomes the image .env)', () => {
  const parsed = require('dotenv').parse(fs.readFileSync(path.join(root, '.env.example')));
  const documented = Object.fromEntries(Object.entries(parsed).filter(([key]) => key.startsWith('LINK_')));
  assert.deepEqual(Object.keys(documented).sort(), LINK_ENV.slice().sort(), 'every LINK_* variable is documented, and only those');
  assert.deepEqual(JSON.parse(JSON.stringify(linkConfig(documented))), JSON.parse(JSON.stringify(linkConfig())));
  assert.equal(documented.LINK_PUBLIC_ENABLED, 'false');
});
