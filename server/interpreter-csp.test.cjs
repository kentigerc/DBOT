const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const transform = require('../scripts/csp-interpreter-loader.cjs');
test('the bot interpreter loads and evaluates normal bot expressions while native string compilation is disabled', () => {
    const source = fs.readFileSync(require.resolve('@deriv/js-interpreter/lib/js-interpreter.js'), 'utf8');
    const module = { exports: {} };
    const context = vm.createContext(
        { module, exports: module.exports, require, console, setTimeout, clearTimeout },
        { codeGeneration: { strings: false, wasm: false } }
    );
    context.self = context;
    vm.runInContext(transform(source), context);
    const Interpreter = context.module.exports;
    const instance = new Interpreter('function twice(n){return n*2;} var values=[1,2,3]; values.map(twice).join(",");');
    instance.run();
    assert.equal(instance.value, '2,4,6');
    const isolated = new Interpreter('typeof document;');
    isolated.run();
    assert.equal(isolated.value, 'undefined');
    assert.throws(() => transform('changed upstream implementation'), /Review/);
});
