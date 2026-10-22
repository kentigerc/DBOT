const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createBotLoader } = require('./bots.cjs');
test('hosted XML requires login, rejects traversal and is never cacheable', async t => {
    const auth = {
        publicOrigin: 'http://localhost',
        sessionExpires: req => {
            if (req.headers.cookie !== 'test=authenticated')
                throw Object.assign(new Error('Unauthorized'), { status: 401 });
            return Date.now() + 1000;
        },
    };
    const server = http.createServer(createBotLoader(auth));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${server.address().port}/api/bots/load?file=`;
    const files = await fs.readdir(path.join(__dirname, 'bots'));
    const file = files.find(file => file.endsWith('.xml'));
    assert.equal((await fetch(base + encodeURIComponent(file))).status, 401);
    const headers = { cookie: 'test=authenticated' };
    const loaded = await fetch(base + encodeURIComponent(file), { headers });
    assert.equal(loaded.status, 200);
    assert.match(loaded.headers.get('cache-control'), /no-store/);
    assert.equal(loaded.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(await loaded.text(), /neto_protected="true"/);
    assert.equal((await fetch(base + encodeURIComponent('../auth.cjs'), { headers })).status, 404);
    assert.equal(
        (await fetch(base + encodeURIComponent(file), { headers: { ...headers, 'sec-fetch-site': 'cross-site' } }))
            .status,
        403
    );
    assert.equal((await fetch(base + encodeURIComponent(file), { method: 'POST', headers })).status, 405);
    for (const filename of files) {
        const content = await fs.readFile(path.join(__dirname, 'bots', filename), 'utf8');
        assert.match(content, /netoacademy:hosted-bot:/, filename);
    }
});
