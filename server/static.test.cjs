const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { serveStatic } = require('./static.cjs');

test('static delivery refuses dotfiles, backups, maps, source paths, traversal and symlink escapes', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neto-static-'));
    const root = path.join(directory, 'dist');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'index.html'), '<h1>NetoAcademy</h1>');
    await fs.writeFile(path.join(root, 'app.js'), '/* public asset */');
    await fs.writeFile(path.join(directory, 'secret'), 'private-file-marker');
    await fs.symlink(path.join(directory, 'secret'), path.join(root, 'escape.txt'));
    const server = http.createServer((req, res) => serveStatic(req, res, { root, origin: 'http://localhost' }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of [
        '/.env',
        '/%2egit/config',
        '/.svn/entries',
        '/app.js.map',
        '/backup.zip',
        '/data.sql',
        '/server/auth.cjs',
        '/src/main.tsx',
        '/test-offline.html',
        '/TEST-OFFLINE.HTML',
        '/.env.backup.jpg',
        '/SERVER/auth.cjs',
        '/app.js.MAP',
        '/..%2fsecret',
        '/escape.txt',
    ]) {
        const response = await fetch(base + route);
        assert.ok([403, 404].includes(response.status), `${route}: ${response.status}`);
        assert.ok(!(await response.text()).includes('private-file-marker'));
    }
    for (const route of ['/app.js%00.png', '/app.js%3Asecret', '/..%5csecret', '/%252e%252e%252fsecret'])
        assert.equal((await fetch(base + route)).status, 400, route);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS'])
        assert.equal((await fetch(base + '/app.js', { method })).status, 405, method);
    assert.equal((await fetch(base + '/BOTS/protected.xml')).status, 403);
    const asset = await fetch(base + '/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    const head = await fetch(base + '/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(base + '/workspace')).status, 200);
});
