const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createAuthHandler } = require('./auth.cjs');
const configuration = require('../config/netoacademy.json');

async function fixture(t, options = {}) {
    const calls = [];
    const handler = createAuthHandler({
        origin: 'http://localhost:5000',
        secret: 'test-only-session-key-that-is-at-least-32-bytes',
        fetchImpl: async (url, init) => {
            calls.push({ url, ...init });
            if (options.upstream) return options.upstream(url, init);
            if (url.endsWith('/oauth2/token'))
                return Response.json({ access_token: 'test-only-bearer', expires_in: 3600 });
            if (url.endsWith('/otp'))
                return Response.json({
                    data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=test-one-time' },
                });
            return Response.json({
                data: [
                    { account_id: 'DOT100', account_type: 'demo', currency: 'USD', balance: 10000, status: 'active' },
                ],
            });
        },
        ...options.handler,
    });
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookies = new Map();
    const request = async (route, body, headers = {}) => {
        const response = await fetch(base + route, {
            redirect: 'manual',
            headers: {
                cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
                ...(body === undefined ? {} : { Origin: 'http://localhost:5000', 'Content-Type': 'application/json' }),
                ...headers,
            },
            ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        });
        for (const cookie of response.headers.getSetCookie()) {
            const [pair] = cookie.split(';');
            const at = pair.indexOf('=');
            cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        return response;
    };
    async function login() {
        const response = await request('/api/auth/login');
        const auth = new URL(response.headers.get('location'));
        return { auth, state: auth.searchParams.get('state') };
    }
    async function authenticated() {
        const { auth, state } = await login();
        const response = await request('/api/auth/callback', { code: 'test-code', state });
        assert.equal(response.status, 200);
        return auth;
    }
    return { request, login, authenticated, cookies, calls };
}

test('login uses the supplied app ID and fresh S256 PKCE; tokens are exchanged server-side', async t => {
    const app = await fixture(t);
    const { auth, state } = await app.login();
    assert.equal(auth.origin + auth.pathname, 'https://auth.deriv.com/oauth2/auth');
    assert.equal(auth.searchParams.get('client_id'), configuration.appId);
    assert.equal(auth.searchParams.get('redirect_uri'), 'http://localhost:5000/callback');
    assert.equal(auth.searchParams.get('scope'), 'trade');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const response = await app.request('/api/auth/callback', { code: 'test-code', state });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).authenticated, true);
    const body = new URLSearchParams(app.calls[0].body);
    assert.equal(body.get('client_id'), configuration.appId);
    assert.equal(body.get('code'), 'test-code');
    assert.equal(
        createHash('sha256').update(body.get('code_verifier')).digest('base64url'),
        auth.searchParams.get('code_challenge')
    );
    assert.ok(!app.cookies.get('neto_session').includes('test-only-bearer'));
    assert.ok(
        response.headers.getSetCookie().some(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'))
    );
    const next = await app.login();
    assert.notEqual(next.state, state);
});

test('wrong state and missing flow fail before contacting token endpoint', async t => {
    const app = await fixture(t);
    await app.login();
    assert.equal((await app.request('/api/auth/callback', { code: 'test-code', state: 'wrong' })).status, 400);
    assert.equal((await app.request('/api/auth/callback', { code: 'test-code', state: 'wrong' })).status, 400);
    assert.equal(app.calls.length, 0);
});

test('foreign origins cannot exchange codes, issue connections or log out a user', async t => {
    const app = await fixture(t);
    for (const route of ['/api/auth/callback', '/api/connection', '/api/auth/logout']) {
        assert.equal((await app.request(route, {}, { Origin: 'https://attacker.example' })).status, 403);
    }
    assert.equal(app.calls.length, 0);
});

test('login cancellation clears flow without creating a session', async t => {
    const app = await fixture(t);
    const { state } = await app.login();
    const response = await app.request('/api/auth/callback', { error: 'access_denied', state });
    assert.equal(response.status, 400);
    assert.equal(app.cookies.get('neto_oauth'), '');
    assert.equal(app.calls.length, 0);
});

test('session returns account metadata and never a bearer token', async t => {
    const app = await fixture(t);
    await app.authenticated();
    const response = await app.request('/api/session');
    const body = await response.json();
    assert.equal(body.accounts[0].account_id, 'DOT100');
    assert.equal(body.authenticated, true);
    assert.ok(!JSON.stringify(body).includes('test-only-bearer'));
    assert.equal(app.calls.at(-1).headers.Authorization, 'Bearer test-only-bearer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unknown accounts cannot request a trading connection', async t => {
    const app = await fixture(t);
    await app.authenticated();
    assert.equal((await app.request('/api/connection', { account_id: 'SOMEONE-ELSE' })).status, 403);
    assert.ok(!app.calls.some(call => call.url.endsWith('/otp')));
});

test('owned account requests get fresh OTP URLs; logout clears authentication', async t => {
    const app = await fixture(t);
    await app.authenticated();
    const response = await app.request('/api/connection', { account_id: 'DOT100' });
    assert.equal(response.status, 200);
    assert.equal(new URL((await response.json()).url).hostname, 'api.derivws.com');
    assert.ok(app.calls.at(-1).url.endsWith('/accounts/DOT100/otp'));
    await app.request('/api/auth/logout', {});
    assert.equal((await (await app.request('/api/session')).json()).authenticated, false);
    assert.equal((await app.request('/api/connection', { account_id: 'DOT100' })).status, 401);
});

test('tampered session cookies are not accepted', async t => {
    const app = await fixture(t);
    await app.authenticated();
    const cookie = app.cookies.get('neto_session');
    app.cookies.set('neto_session', (cookie[0] === 'A' ? 'B' : 'A') + cookie.slice(1));
    assert.equal((await (await app.request('/api/session')).json()).authenticated, false);
});

test('expired session is refused without contacting Deriv', async t => {
    let clock = 100000;
    const app = await fixture(t, { handler: { now: () => clock } });
    await app.authenticated();
    const count = app.calls.length;
    clock += 3600001;
    assert.equal((await (await app.request('/api/session')).json()).authenticated, false);
    assert.equal(app.calls.length, count);
});

test('unexpected OTP destination fails closed', async t => {
    const app = await fixture(t, {
        upstream: async url => {
            if (url.endsWith('/oauth2/token'))
                return Response.json({ access_token: 'test-only-bearer', expires_in: 3600 });
            if (url.endsWith('/otp'))
                return Response.json({ data: { url: 'wss://attacker.example/trading/v1/options/ws/demo?otp=secret' } });
            return Response.json({
                data: [{ account_id: 'DOT100', status: 'active', currency: 'USD', account_type: 'demo' }],
            });
        },
    });
    await app.authenticated();
    assert.equal((await app.request('/api/connection', { account_id: 'DOT100' })).status, 502);
});

test('production needs a strong secret and HTTPS', () => {
    assert.throws(() => createAuthHandler({ secret: 'short' }), /32 bytes/);
    assert.throws(() => createAuthHandler({ origin: 'http://netoacademy.com', secret: 'x'.repeat(32) }), /HTTPS/);
});
