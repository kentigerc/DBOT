const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transform, specifications } = require('../scripts/patch-vendor-security.cjs');
// Test the actual bundled factory, rather than only the standalone npm package.
function chartSetter(source) {
    const { parse } = require('@babel/parser');
    const tree = parse(source, { sourceType: 'unambiguous' });
    let factory;
    function visit(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ObjectProperty' && node.key?.value === 6571)
            factory = source.slice(node.value.start, node.value.end);
        for (const [key, value] of Object.entries(node)) {
            if (key === 'loc') continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    }
    visit(tree);
    assert.ok(factory, 'the expected embedded setter factory exists');
    return `(${factory} )(module, module.exports, { g: globalThis });`;
}
for (const specification of specifications) {
    test(`security backport protects actual ${specification.file}`, () => {
        const source = fs.readFileSync(require.resolve(specification.file), 'utf8');
        const patched = transform(source, specification);
        assert.equal(transform(patched, specification), patched, 'patch is idempotent');
        assert.throws(
            () => transform(patched + '\n//unexpected upstream edit', specification),
            /upstream contents changed/
        );
        const context = vm.createContext({ module: { exports: {} } });
        vm.runInContext(specification.file.startsWith('@deriv/') ? chartSetter(patched) : patched, context);
        vm.runInContext(
            `
            const applySet = module.exports;
            const result = {};
            applySet(result, 'series[0].color', 'green');
            if (result.series[0].color !== 'green') throw Error('normal path failed');
            if (applySet(result, ['series', 1, 'value'], 42) !== result) throw Error('return value changed');
            if (result.series[1].value !== 42) throw Error('array path failed');
            applySet(result, 'settings["color.name"]', 'blue');
            if (result.settings['color.name'] !== 'blue') throw Error('quoted path failed');
            for (const path of ['__proto__.netoProbe', 'constructor.prototype.netoProbe', ['__proto__', 'netoProbe'], ['constructor', 'prototype', 'netoProbe'], 'nested.__proto__.netoProbe']) {
                applySet({}, path, true);
                if (({}).netoProbe !== undefined || Object.prototype.netoProbe !== undefined) throw Error('prototype pollution');
            }
        `,
            context
        );
    });
}

// The separately installed package must resolve to the maintained implementation.
test('lodash.set compatibility adapter uses maintained lodash/set and blocks prototype paths', () => {
    const setter = require('lodash.set');
    assert.equal(setter, require('lodash/set'));
    const target = {};
    assert.equal(setter(target, 'a[0].b', 7), target);
    assert.equal(target.a[0].b, 7);
    setter({}, '__proto__.netoAdapterProbe', true);
    setter({}, 'constructor.prototype.netoAdapterProbe', true);
    assert.equal(Object.prototype.netoAdapterProbe, undefined);
});

test('deepmerge fork blocks poisoned target and source without breaking tour configuration merges', () => {
    const merge = require('deepmerge');
    const payload = JSON.parse(
        '{"__proto__":{"netoMergeProbe":true},"constructor":{"prototype":{"netoMergeProbe":true}},"safe":{"color":"red"}}'
    );
    for (const [target, source] of [
        [payload, {}],
        [{}, payload],
        [payload, payload],
    ]) {
        const result = merge(target, source);
        assert.equal(Object.getPrototypeOf(result), Object.prototype);
        assert.equal(Object.prototype.netoMergeProbe, undefined);
        assert.equal(result.netoMergeProbe, undefined);
        assert.equal(result.safe.color, 'red');
        assert.equal(Object.hasOwn(result, '__proto__'), false);
        assert.equal(Object.hasOwn(result, 'constructor'), false);
    }
    const first = { options: { color: 'red' }, steps: [1] };
    const result = merge(first, { options: { size: 3 }, steps: [2] });
    assert.deepEqual(result, { options: { color: 'red', size: 3 }, steps: [1, 2] });
    assert.notEqual(result.options, first.options);
    assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
    assert.deepEqual(merge({ a: [1] }, { a: [2] }, { arrayMerge: (_, source) => source }), { a: [2] });
    assert.deepEqual(
        merge(
            { n: 2 },
            { n: 3 },
            {
                customMerge: key => (key === 'n' ? (a, b) => a + b : undefined),
                isMergeableObject: value => typeof value === 'number' || (!!value && typeof value === 'object'),
            }
        ),
        { n: 5 }
    );
});

test('all consumers resolve the patched compatibility packages', () => {
    const path = require('node:path');
    for (const consumer of ['react-joyride', 'react-floater', '@rsbuild/plugin-sass', 'jest-config']) {
        const resolved = require.resolve('deepmerge', { paths: [path.dirname(require.resolve(consumer))] });
        assert.equal(resolved, require.resolve('../vendor/deepmerge'), consumer);
    }
    const chartSetterPath = require.resolve('lodash.set', {
        paths: [path.dirname(require.resolve('@deriv/deriv-charts'))],
    });
    assert.equal(chartSetterPath, require.resolve('../vendor/lodash-set'));
});
