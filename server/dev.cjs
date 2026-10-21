const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const children = [
    spawn(process.execPath, ['server/index.cjs', '--dev'], { cwd: root, stdio: 'inherit' }),
    spawn(process.execPath, ['node_modules/@rsbuild/core/bin/rsbuild.js', 'dev', '--open', 'false'], {
        cwd: root,
        stdio: 'inherit',
    }),
];
let stopping = false;
function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
    process.exitCode = code;
}
for (const child of children) {
    child.on('error', () => stop(1));
    child.on('exit', code => stop(code || 0));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
