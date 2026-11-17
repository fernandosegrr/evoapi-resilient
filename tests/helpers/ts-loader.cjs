// Loads a TypeScript source file of this repo into an isolated vm context, with the repo's path aliases replaced by the
// stubs the caller provides. The same approach as the older tests, shared so new tests do not copy it.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

function loadTs(file, stubs = {}, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (name) => (name in stubs ? stubs[name] : require(name)),
    process,
    console,
    Buffer,
    URL,
    // Resolved at call time so node:test's mock timers (installed per test) are what the code sees.
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
    setInterval: (...args) => globalThis.setInterval(...args),
    clearInterval: (...args) => globalThis.clearInterval(...args),
    ...globals,
  });
  return module.exports;
}

module.exports = { loadTs, root };
