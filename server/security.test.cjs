const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSecurity, clientAddress, tokenBucket, validateSocketMessage } = require('./security.cjs');
const req = (ip = '127.0.0.1', headers = {}) => ({ socket: { remoteAddress: ip }, headers });

test('forwarded client addresses are ignored unless a fixed proxy hop count is trusted', () => {
    const request = req('10.0.0.1', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    assert.equal(clientAddress(request), '10.0.0.1');
    assert.equal(clientAddress(request, 1), '5.6.7.8'); // Attacker-controlled leading entry is not trusted.
    assert.equal(clientAddress(req('10.0.0.1', { 'x-forwarded-for': 'nonsense' }), 1), '10.0.0.1');
    assert.throws(() => createSecurity({ trustedProxyHops: -1 }));
});
test('token buckets permit legitimate bursts, throttle floods and refill with elapsed time', () => {
    let at = 0;
    const take = tokenBucket(2, 2, () => at);
    assert.equal(take(), true);
    assert.equal(take(), true);
    assert.equal(take(), false);
    at = 500;
    assert.equal(take(), true);
    assert.equal(take(), false);
});
async function fixture(t, options = {}) {
    const audit = [];
    const security = createSecurity({ origin: 'https://neto.example', audit: e => audit.push(e), ...options });
    let calls = 0;
    const server = http.createServer((request, response) => {
        if (security.handle(request, response)) {
            calls++;
            response.end('ok');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        port: server.address().port,
        request: (route, init) => fetch(base + route, init),
        audit,
        calls: () => calls,
    };
}
test('browser protections and no-store apply to every API response, including rate-limit errors', async t => {
    const app = await fixture(t, { apiRate: 0, apiBurst: 1 });
    const first = await app.request('/api/session');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-frame-options'), 'DENY');
    assert.match(first.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok(!first.headers.get('content-security-policy').includes("'unsafe-eval'"));
    assert.equal(first.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
    const second = await app.request('/api/session', { headers: { 'x-forwarded-for': '8.8.8.8' } });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get('retry-after'), '2');
    assert.equal(app.calls(), 1);
    assert.ok(!JSON.stringify(app.audit).includes('8.8.8.8'));
});
test('large requests and cross-site API calls fail before routing', async t => {
    const app = await fixture(t);
    assert.equal((await app.request('/api/auth/callback', { method: 'POST', body: 'x'.repeat(8193) })).status, 413);
    assert.equal((await app.request('/api/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal(app.calls(), 0);
});
test('socket quotas count pending handshakes, cannot be bypassed with forwarded headers, and release once', () => {
    const security = createSecurity({ sessionIdentity: () => 'verified-sid', socketsPerSession: 1, audit: () => {} });
    const release = security.reserveSocket(req());
    assert.equal(typeof release, 'function');
    assert.equal(security.reserveSocket(req('8.8.8.8')), undefined);
    release();
    release();
    const next = security.reserveSocket(req('8.8.8.8'));
    assert.equal(typeof next, 'function');
    next();
});
test('malformed socket messages, account reauthorization and private operations on public sockets are refused', () => {
    for (const value of [null, [], 1, 'x', { authorize: 'secret' }, { api_token: 1 }])
        assert.throws(() => validateSocketMessage(value, 'DOT100'));
    assert.throws(() => validateSocketMessage({ buy: 1 }, null));
    assert.doesNotThrow(() => validateSocketMessage({ ticks_history: 'R_10', count: 1000 }, null));
    assert.doesNotThrow(() => validateSocketMessage({ buy: 'proposal', price: 0.35 }, 'DOT100'));
});
test('duplicate query parameters are rejected instead of selecting an ambiguous account', async t => {
    const app = await fixture(t);
    assert.equal((await app.request('/api/analysis?account_id=own&account_id=other')).status, 400);
    assert.equal(app.calls(), 0);
});
test('the Node HTTP parser rejects conflicting transfer framing before the request handler', async t => {
    const app = await fixture(t);
    const reply = await new Promise((resolve, reject) => {
        const socket = require('node:net').connect(app.port, '127.0.0.1');
        let data = '';
        socket.setTimeout(2000, () => {
            socket.destroy();
            reject(new Error('Local parser test timed out'));
        });
        socket.on('error', reject);
        socket.on('data', chunk => {
            data += chunk;
        });
        socket.on('close', () => resolve(data));
        socket.on('connect', () =>
            socket.end(
                'POST /api/session HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'
            )
        );
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
    assert.equal(app.calls(), 0);
});
