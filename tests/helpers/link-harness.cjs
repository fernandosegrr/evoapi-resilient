// The real LinkService on top of the real WAMonitoringService (tests/helpers/monitor-harness.cjs), with an in-memory
// stand-in for the LinkToken table that implements the Prisma operators the service uses (equality, lt/lte/gt/gte/in,
// OR, increment) so that the atomic quota updates behave like conditional UPDATEs.
const { loadTs } = require('./ts-loader.cjs');
const { createHarness, NAME, INSTANCE_ID } = require('./monitor-harness.cjs');

const token = loadTs('src/utils/linkToken.ts');
const phone = loadTs('src/utils/linkPhone.ts');

const linkLogs = { current: [] };
class LinkLogger {
  info(message) {
    linkLogs.current.push(['info', message]);
  }
  warn(message) {
    linkLogs.current.push(['warn', message]);
  }
  error(message) {
    linkLogs.current.push(['error', message]);
  }
  log(message) {
    linkLogs.current.push(['log', message]);
  }
}

const linkModule = loadTs('src/api/services/link.service.ts', {
  '@api/types/wa.types': { Integration: { WHATSAPP_BAILEYS: 'WHATSAPP-BAILEYS' } },
  '@config/logger.config': { Logger: LinkLogger },
  '@utils/linkPhone': phone,
  '@utils/linkToken': token,
});

// Dates built inside the vm context are not instanceof the host's Date.
const isDate = (value) => Object.prototype.toString.call(value) === '[object Date]';
const asNumber = (value) => (isDate(value) ? value.getTime() : value);

function matches(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((sub) => matches(row, sub));
    if (key === 'AND') return condition.every((sub) => matches(row, sub));
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !isDate(condition)) {
      return Object.entries(condition).every(([operator, expected]) => {
        if (operator === 'in') return expected.includes(value);
        if (value === null || value === undefined) return false; // SQL: comparisons with NULL are never true
        const left = asNumber(value);
        const right = asNumber(expected);
        if (operator === 'lt') return left < right;
        if (operator === 'lte') return left <= right;
        if (operator === 'gt') return left > right;
        if (operator === 'gte') return left >= right;
        throw new Error(`unsupported operator ${operator}`);
      });
    }
    return asNumber(value) === asNumber(condition) || (condition === null && value === undefined);
  });
}

function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !isDate(value)) {
      if ('increment' in value) row[key] += value.increment;
      else if ('decrement' in value) row[key] -= value.decrement;
      else throw new Error(`unsupported data operator for ${key}`);
    } else row[key] = value;
  }
}

function createLinkPrisma({ clock, clientName, instanceRow }) {
  const rows = [];
  const calls = { create: 0, updateMany: 0, findUnique: 0, findMany: 0, count: 0 };
  let sequence = 0;
  const withInstance = (row, include) =>
    include?.Instance
      ? { ...row, Instance: { name: instanceRow.name, clientName: instanceRow.clientName, integration: instanceRow.integration } }
      : { ...row };
  return {
    rows,
    calls,
    instance: {
      findFirst: async ({ where }) => {
        const wanted = where ?? {};
        if (wanted.name !== undefined && wanted.name !== instanceRow.name) return null;
        if (wanted.clientName !== undefined && wanted.clientName !== instanceRow.clientName) return null;
        return { ...instanceRow };
      },
    },
    linkToken: {
      create: async ({ data }) => {
        calls.create++;
        const row = {
          id: `link-${++sequence}`,
          displayName: null,
          allowReset: false,
          expectedNumber: null,
          createdAt: new Date(clock()),
          consumedAt: null,
          revokedAt: null,
          attemptCount: 0,
          autoResets: 0,
          windowStartedAt: null,
          windowAttempts: 0,
          lastAttemptAt: null,
          ...data,
        };
        rows.push(row);
        return { ...row };
      },
      findUnique: async ({ where, include }) => {
        calls.findUnique++;
        const row = rows.find((candidate) => matches(candidate, where));
        return row ? withInstance(row, include) : null;
      },
      findMany: async ({ where, orderBy, take }) => {
        calls.findMany++;
        let found = rows.filter((candidate) => matches(candidate, where));
        if (orderBy?.createdAt === 'desc') found = [...found].reverse();
        return found.slice(0, take ?? found.length).map((row) => ({ ...row }));
      },
      count: async ({ where }) => {
        calls.count++;
        return rows.filter((candidate) => matches(candidate, where)).length;
      },
      updateMany: async ({ where, data }) => {
        calls.updateMany++;
        const found = rows.filter((candidate) => matches(candidate, where));
        for (const row of found) applyData(row, data);
        return { count: found.length };
      },
    },
  };
}

// Time is whatever the test mocks (Date and setTimeout), read at call time.
const clock = () => Date.now();

function createLinkHarness({ env = {}, instance = {}, ...options } = {}) {
  const monitorHarness = createHarness({ env: { DATABASE_CONNECTION_CLIENT_NAME: 'test-client', ...env }, ...options });
  const clientName = monitorHarness.configService.get('DATABASE').CONNECTION.CLIENT_NAME;
  const instanceRow = {
    id: INSTANCE_ID,
    name: NAME,
    clientName,
    integration: 'WHATSAPP-BAILEYS',
    connectionStatus: 'close',
    disconnectionObject: null,
    ...instance,
  };
  linkLogs.current = [];
  const prisma = createLinkPrisma({ clock, clientName, instanceRow });
  const linkService = new linkModule.LinkService(prisma, monitorHarness.service, monitorHarness.configService, clock);

  // Creates a link and returns what the administrator receives plus the raw token the customer would hold.
  const newLink = async (input = {}) => linkService.createLink({ instanceName: NAME, ...input });

  return {
    ...monitorHarness,
    linkService,
    prisma,
    instanceRow,
    newLink,
    linkLogs: linkLogs.current,
    row: (id) => prisma.rows.find((candidate) => candidate.id === id),
    // What WhatsApp does once the socket is up: it delivers a QR (and the pairing code is requested for the number).
    deliverQr(runtime, { count = 1, pairingCode = 'ABCD1234', base64 = 'data:image/png;base64,QUJD' } = {}) {
      runtime.qrCount = count;
      runtime.pairingCode = pairingCode;
      runtime.base64 = base64;
    },
  };
}

module.exports = { createLinkHarness, linkModule, token, phone, linkLogs, matches, applyData, NAME, INSTANCE_ID };
