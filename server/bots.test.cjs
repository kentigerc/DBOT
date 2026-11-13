const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createBotLoader } = require('./bots.cjs');
test('hosted XML requires login, rejects traversal and is never cacheable', async t => {
    const auth = {
        publicOrigin: 'http://localhost',
        verifySession: async req => {
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

test('hosted bot access rejects a replayed session after shared logout revocation', async t => {
    let revoked = false;
    const { createAuthHandler } = require('./auth.cjs');
    const auth = createAuthHandler({
        origin: 'http://localhost',
        secret: 'test-only-bot-session-key-with-at-least-32-bytes',
        revocations: { isRevoked: async () => revoked },
        fetchImpl: async () => Response.json({ access_token: 'test-only-bearer', expires_in: 3600 }),
    });
    const load = createBotLoader(auth);
    const server = http.createServer((req, res) =>
        req.url.startsWith('/api/bots/load') ? load(req, res) : auth(req, res)
    );
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(base + '/api/auth/login', { redirect: 'manual' });
    const state = new URL(login.headers.get('location')).searchParams.get('state');
    const callback = await fetch(base + '/api/auth/callback', {
        method: 'POST',
        headers: {
            origin: 'http://localhost',
            'content-type': 'application/json',
            cookie: login.headers.getSetCookie()[0].split(';')[0],
        },
        body: JSON.stringify({ code: 'test-only-code', state }),
    });
    assert.equal(callback.status, 200);
    const cookie = callback.headers
        .getSetCookie()
        .find(value => value.startsWith('neto_session='))
        .split(';')[0];
    const file = (await fs.readdir(path.join(__dirname, 'bots'))).find(value => value.endsWith('.xml'));
    const request = () => fetch(base + '/api/bots/load?file=' + encodeURIComponent(file), { headers: { cookie } });
    assert.equal((await request()).status, 200);
    revoked = true; // Models logout saved by a different server instance.
    const response = await request();
    assert.equal(response.status, 401);
    assert.doesNotMatch(await response.text(), /<xml|neto_protected/);
});
