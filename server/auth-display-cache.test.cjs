const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAuthHandler } = require('./auth.cjs');
const terms = require('../config/terms.json');
function fixture() {
    const state = { now: Date.now(), calls: 0, limited: false, removed: false, revoked: false, tokens: 0 };
    const auth = createAuthHandler({
        origin: 'https://neto.example',
        secret: 'test-only-account-cache-secret-at-least-32-bytes',
        now: () => state.now,
        revocations: {
            isRevoked: async () => state.revoked,
            revoke: async () => {
                state.revoked = true;
            },
        },
        fetchImpl: async url => {
            if (url.endsWith('/oauth2/token'))
                return Response.json({ access_token: `cache-test-${++state.tokens}`, expires_in: 3600 });
            if (url.endsWith('/otp'))
                return Response.json({
                    data: { url: 'wss://api.derivws.com/trading/v1/options/ws/demo?otp=test-only' },
                });
            state.calls++;
            if (state.limited) return Response.json({}, { status: 429, headers: { 'Retry-After': '427' } });
            return Response.json({
                data: state.removed
                    ? []
                    : [{ account_id: 'DOT100', account_type: 'demo', status: 'active', currency: 'USD', balance: 100 }],
            });
        },
    });
    const cookies = new Map();
    const req = () => ({ headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    async function request(url, body) {
        const input = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
        input.url = url;
        input.method = body === undefined ? 'GET' : 'POST';
        input.headers = {
            ...req().headers,
            origin: 'https://neto.example',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        };
        const headers = new Headers();
        let status, data;
        const response = {
            setHeader: (key, value) => {
                headers.delete(key);
                for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
            },
            getHeader: key => (key.toLowerCase() === 'set-cookie' ? headers.getSetCookie() : headers.get(key)),
            writeHead: (code, values = {}) => {
                status = code;
                for (const [key, value] of Object.entries(values)) headers.set(key, value);
            },
            end: value => {
                data = value;
            },
        };
        await auth(input, response);
        for (const line of headers.getSetCookie()) {
            const [pair] = line.split(';');
            const at = pair.indexOf('=');
            cookies.set(pair.slice(0, at), pair.slice(at + 1));
        }
        return { status, headers, json: () => JSON.parse(data) };
    }
    async function login() {
        const start = await request('/api/auth/login');
        const flow = new URL(start.headers.get('location'));
        assert.equal(
            (await request('/api/auth/callback', { code: 'test-code', state: flow.searchParams.get('state') })).status,
            200
        );
        assert.equal((await request('/api/auth/terms', { accepted: true, version: terms.version })).status, 200);
    }
    return { state, auth, req, request, login };
}
test('page refreshes reuse a five-minute display snapshot while trading revalidates after thirty seconds', async () => {
    const f = fixture();
    await f.login();
    assert.equal((await f.request('/api/session')).status, 200);
    for (let minute = 1; minute <= 4; minute++) {
        f.state.now += 60000;
        assert.equal((await f.request('/api/session')).status, 200);
    }
    assert.equal(f.state.calls, 1);
    f.state.removed = true;
    await assert.rejects(f.auth.authorizeAccount(f.req(), 'DOT100'), { status: 403 });
    assert.equal(f.state.calls, 2, 'trading must not use the display authorization snapshot');
    assert.deepEqual((await f.request('/api/session')).json().accounts, []);
});
test('a bounded snapshot keeps the workspace available during throttling without authorizing trades', async () => {
    const f = fixture();
    await f.login();
    await f.request('/api/session');
    f.state.now += 300000;
    f.state.limited = true;
    const limited = await f.request('/api/session');
    assert.equal(limited.status, 200);
    assert.equal(limited.json().accountRefreshRetryAfter, 427);
    assert.equal(limited.json().accounts[0].account_id, 'DOT100');
    await assert.rejects(f.auth.authorizeAccount(f.req(), 'DOT100'), { status: 429 });
    assert.equal(f.state.calls, 2, 'cooldown must suppress additional provider calls');
    f.state.now += 1000;
    assert.equal((await f.request('/api/session')).json().accountRefreshRetryAfter, 426);
    assert.equal(f.state.calls, 2);
    f.state.now += 426000;
    f.state.limited = false;
    const recovered = await f.request('/api/session');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json().accountRefreshRetryAfter, undefined);
    assert.equal(f.state.calls, 3);
});
test('display fallback expires after fifteen minutes and never crosses credentials', async () => {
    const f = fixture();
    await f.login();
    await f.request('/api/session');
    f.state.now += 900000;
    f.state.limited = true;
    assert.equal((await f.request('/api/session')).status, 429);
    await f.login();
    assert.equal((await f.request('/api/session')).status, 429, 'a new credential cannot use the previous snapshot');
    f.state.revoked = true;
    assert.equal((await f.request('/api/session')).status, 401);
});

test('revocation and logout cannot reuse a display snapshot', async () => {
    const f = fixture();
    await f.login();
    await f.request('/api/session');
    f.state.revoked = true;
    const rejected = await f.request('/api/session');
    assert.equal(rejected.status, 401);
    assert.equal(rejected.json().accounts, undefined);
    f.state.revoked = false;
    await f.login();
    await f.request('/api/session');
    assert.equal((await f.request('/api/auth/logout', {})).status, 200);
    assert.deepEqual((await f.request('/api/session')).json(), { authenticated: false, accounts: [] });
});
