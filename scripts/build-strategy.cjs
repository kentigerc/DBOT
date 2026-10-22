const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.server-build'), { recursive: true });
for (const [source, name] of [
    ['src/services/digit-strategy/strategy.ts', 'strategy'],
    ['src/services/digit-strategy/engine.ts', 'engine'],
    ['src/external/bot-skeleton/services/api/new-api-transport.js', 'transport'],
]) {
    const result = ts.transpileModule(fs.readFileSync(path.join(root, source), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    fs.writeFileSync(path.join(root, '.server-build', `${name}.js`), result.outputText);
}
