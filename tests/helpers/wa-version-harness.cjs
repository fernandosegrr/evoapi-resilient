const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { loadTs, root } = require('./ts-loader.cjs');
const bundled = [2, 3000, 1035194821];
const fresh = [2, 3000, 1234567890];
const declaration = (version) => `// moved declaration\n\nexport const version: WAVersion = [${version.join(', ')}];\n`;
function versionHarness(remote = async () => declaration(fresh), options = {}) {
  let now = 1_000_000;
  let calls = 0;
  const agents = [],
    logs = [],
    files = new Map();
  const cachePath = 'synthetic-wa-version.json';
  if (options.persisted) files.set(cachePath, JSON.stringify(options.persisted));
  const fetchMock = async (...args) => {
    calls++;
    const source = await remote(...args);
    if (typeof source === 'string') return { ok: true, headers: { get: () => null }, text: async () => source };
    return source;
  };
  class Agent {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      agents.push(this);
    }
    async destroy() {
      this.destroyed = true;
    }
  }
  class Logger {
    info(value) {
      logs.push(value);
    }
    warn(value) {
      logs.push(value);
    }
  }
  const generics = fs.readFileSync(path.join(root, 'node_modules/baileys/lib/Utils/generics.js'), 'utf8');
  const ast = ts.createSourceFile('generics.js', generics, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const stock = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((n) => [...n.declarationList.declarations])
    .find((n) => n.name.getText(ast) === 'fetchLatestBaileysVersion');
  const stockModule = { exports: {} };
  vm.runInNewContext(`module.exports=${stock.initializer.getText(ast)}`, {
    module: stockModule,
    fetch: fetchMock,
    version: bundled,
    Boom: Error,
  });
  const helper = loadTs(
    'src/utils/fetchLatestWaWebVersion.ts',
    {
      '@config/logger.config': { Logger },
      baileys: { DEFAULT_CONNECTION_CONFIG: { version: bundled }, fetchLatestBaileysVersion: stockModule.exports },
      undici: { Agent, fetch: fetchMock },
      'fs/promises': {
        stat: async (name) => {
          if (!files.has(name)) throw Error('ENOENT');
          return { size: files.get(name).length };
        },
        readFile: async (name) => {
          if (!files.has(name)) throw Error('ENOENT');
          return files.get(name);
        },
        mkdir: async () => {},
        writeFile: async (name, data) => {
          if (options.diskFailure) throw Error('Read-only');
          files.set(name, data);
        },
        rename: async (from, to) => {
          files.set(to, files.get(from));
          files.delete(from);
        },
      },
    },
    {
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      AbortController,
      process: {
        env: { WA_VERSION_CACHE_PATH: cachePath, WA_VERSION_MAX_AGE_MS: options.maxAgeMs?.toString() },
        cwd: () => root,
        pid: 123,
      },
    },
  );
  return {
    ...helper,
    lookup: helper.fetchLatestWaWebVersion,
    agents,
    files,
    logs,
    bundled,
    fresh,
    declaration,
    calls: () => calls,
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    settle: async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}
module.exports = { versionHarness, bundled, fresh, declaration };
