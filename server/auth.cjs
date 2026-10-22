const { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const configuration = require('../config/netoacademy.json');

const AUTH_ORIGIN = 'https://auth.deriv.com';
const API_ORIGIN = 'https://api.derivws.com';
const SESSION_COOKIE = 'neto_session';
const FLOW_COOKIE = 'neto_oauth';

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// Tokens stay in authenticated, encrypted HttpOnly cookies, never browser storage.
function createAuthHandler({
    origin = configuration.origin,
    secret = process.env.NETO_SESSION_SECRET,
    fetchImpl = fetch,
    now = () => Date.now(),
} = {}) {
    const publicOrigin = new URL(origin).origin;
    const secure = publicOrigin.startsWith('https:');
    if (!secure && !['localhost', '127.0.0.1'].includes(new URL(publicOrigin).hostname)) {
        throw new Error('NETO_ORIGIN must use HTTPS except on localhost.');
    }
    if (!secret || Buffer.byteLength(secret) < 32) {
        throw new Error('NETO_SESSION_SECRET must contain at least 32 bytes. Set it securely on the server.');
    }
    const key = createHash('sha256').update(secret).digest();
    const redirectUri = publicOrigin + configuration.callbackPath;
    // One-time flow consumption is shared across instances using an encrypted cookie
    // cleared before exchange. Deriv also enforces single-use authorization codes.
    function seal(value, purpose) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(Buffer.from(purpose));
        return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString(
            'base64url'
        );
    }
    function unseal(value, purpose) {
        try {
            const bytes = Buffer.from(value || '', 'base64url');
            if (bytes.length < 29) return null;
            const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
            decipher.setAAD(Buffer.from(purpose));
            decipher.setAuthTag(bytes.subarray(-16));
            const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]));
            return data.expires > now() ? data : null;
        } catch {
            return null;
        }
    }
    function setCookie(res, name, data, seconds) {
        const cookie = `${name}=${data ? seal(data, name) : ''}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
        const existing = res.getHeader('Set-Cookie') || [];
        res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : [existing]), cookie]);
    }
    function readCookie(req, name) {
        const raw = (req.headers.cookie || '')
            .split(';')
            .map(part => part.trim())
            .find(part => part.startsWith(`${name}=`));
        return unseal(raw?.slice(name.length + 1), name);
    }
    function json(res, status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    }
    async function readBody(req) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
        let data = '';
        for await (const chunk of req) {
            data += chunk;
            if (Buffer.byteLength(data) > 8192) throw new HttpError(413, 'Request too large.');
        }
        try {
            return JSON.parse(data);
        } catch {
            throw new HttpError(400, 'Invalid JSON.');
        }
    }
    async function requestJson(url, options) {
        let response;
        try {
            response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
        } catch {
            throw new HttpError(502, 'Unable to reach Deriv. Please try again.');
        }
        // Do not forward upstream bodies: they can contain credentials or authorization codes.
        if (!response.ok) {
            if (response.status === 401) throw new HttpError(401, 'Your Deriv session expired. Please log in again.');
            throw new HttpError(
                502,
                `Deriv rejected the request (HTTP ${response.status}). Check the app registration and try again.`
            );
        }
        return response.json();
    }
    async function getAccounts(token) {
        const result = await requestJson(`${API_ORIGIN}/trading/v1/options/accounts`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!Array.isArray(result.data)) throw new HttpError(502, 'Deriv returned an unexpected accounts response.');
        return result.data
            .map(account => ({
                account_id: account.account_id,
                account_type: account.account_type,
                currency: account.currency,
                balance: account.balance,
                status: account.status,
            }))
            .filter(account => typeof account.account_id === 'string');
    }
    function session(req) {
        const value = readCookie(req, SESSION_COOKIE);
        if (!value?.access_token) throw new HttpError(401, 'Please log in to Deriv.');
        return value;
    }
    async function connectionUrl(req, account_id) {
        const saved = session(req);
        const accounts = await getAccounts(saved.access_token);
        if (!accounts.some(account => account.account_id === account_id && account.status === 'active')) {
            throw new HttpError(403, 'This trading account is not available in your Deriv session.');
        }
        const result = await requestJson(
            `${API_ORIGIN}/trading/v1/options/accounts/${encodeURIComponent(account_id)}/otp`,
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${saved.access_token}` },
            }
        );
        let socket;
        try {
            socket = new URL(result.data?.url);
        } catch {
            throw new HttpError(502, 'Deriv returned an invalid connection URL.');
        }
        if (
            socket.protocol !== 'wss:' ||
            socket.hostname !== 'api.derivws.com' ||
            socket.port ||
            socket.username ||
            socket.password ||
            !['/trading/v1/options/ws/demo', '/trading/v1/options/ws/real'].includes(socket.pathname) ||
            !socket.searchParams.get('otp')
        ) {
            throw new HttpError(502, 'Deriv returned an unexpected connection URL.');
        }
        return socket.toString();
    }
    const handle = async function (req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        try {
            const url = new URL(req.url, publicOrigin);
            if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
            if (req.method === 'POST' && req.headers.origin !== publicOrigin)
                throw new HttpError(403, 'Invalid request origin.');
            if (url.pathname === '/api/auth/login' && req.method === 'GET') {
                if (req.headers['sec-fetch-site'] === 'cross-site')
                    throw new HttpError(403, 'Start login from NetoAcademy.');
                const verifier = randomBytes(48).toString('base64url');
                const state = randomBytes(32).toString('base64url');
                setCookie(res, FLOW_COOKIE, { verifier, state, expires: now() + 600000 }, 600);
                const auth = new URL('/oauth2/auth', AUTH_ORIGIN);
                auth.search = new URLSearchParams({
                    response_type: 'code',
                    client_id: configuration.appId,
                    redirect_uri: redirectUri,
                    scope: 'trade',
                    state,
                    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
                    code_challenge_method: 'S256',
                }).toString();
                res.writeHead(302, { Location: auth.toString() });
                return res.end();
            }
            if (url.pathname === '/api/auth/callback' && req.method === 'POST') {
                const body = await readBody(req);
                const flow = readCookie(req, FLOW_COOKIE);
                setCookie(res, FLOW_COOKIE, null, 0);
                if (
                    !flow ||
                    typeof body.state !== 'string' ||
                    Buffer.byteLength(body.state) !== Buffer.byteLength(flow.state) ||
                    !timingSafeEqual(Buffer.from(body.state), Buffer.from(flow.state))
                ) {
                    throw new HttpError(400, 'Login expired or state did not match. Start login again.');
                }
                if (body.error) throw new HttpError(400, 'Deriv login was cancelled or declined.');
                if (typeof body.code !== 'string' || !body.code || body.code.length > 4096)
                    throw new HttpError(400, 'Missing authorization code.');
                const tokens = await requestJson(`${AUTH_ORIGIN}/oauth2/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: configuration.appId,
                        code: body.code,
                        code_verifier: flow.verifier,
                        redirect_uri: redirectUri,
                    }).toString(),
                });
                if (
                    typeof tokens.access_token !== 'string' ||
                    !tokens.access_token ||
                    tokens.access_token.length > 2000 ||
                    !Number.isFinite(Number(tokens.expires_in)) ||
                    Number(tokens.expires_in) <= 0
                ) {
                    throw new HttpError(502, 'Deriv returned an invalid session.');
                }
                const seconds = Math.min(Number(tokens.expires_in), 3600);
                setCookie(
                    res,
                    SESSION_COOKIE,
                    { access_token: tokens.access_token, expires: now() + seconds * 1000 },
                    seconds
                );
                return json(res, 200, { authenticated: true });
            }
            if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
                setCookie(res, SESSION_COOKIE, null, 0);
                setCookie(res, FLOW_COOKIE, null, 0);
                return json(res, 200, { authenticated: false });
            }
            if (url.pathname === '/api/session' && req.method === 'GET') {
                const saved = readCookie(req, SESSION_COOKIE);
                if (!saved?.access_token) return json(res, 200, { authenticated: false, accounts: [] });
                const accounts = await getAccounts(saved.access_token);
                return json(res, 200, { authenticated: true, accounts });
            }
            if (url.pathname === '/api/connection' && req.method === 'POST') {
                const { account_id } = await readBody(req);
                return json(res, 200, { url: await connectionUrl(req, account_id) });
            }
            return json(res, 404, { error: 'API route not found.' });
        } catch (error) {
            if (error.status === 401) setCookie(res, SESSION_COOKIE, null, 0);
            return json(res, error.status || 500, {
                error: error.status ? error.message : 'Unable to complete the request.',
            });
        }
    };
    const accountCache = new Map();
    handle.authorizeAccount = async (req, accountId) => {
        const saved = session(req);
        const cacheKey = createHash('sha256').update(saved.access_token).digest('hex');
        let cached = accountCache.get(cacheKey);
        if (!cached || cached.until < now()) {
            cached = { accounts: await getAccounts(saved.access_token), until: now() + 30000 };
            if (accountCache.size > 1000) accountCache.clear();
            accountCache.set(cacheKey, cached);
        }
        const account = cached.accounts.find(item => item.account_id === accountId && item.status === 'active');
        if (!account) throw new HttpError(403, 'This trading account is not available in your Deriv session.');
        return account;
    };
    handle.connectionUrl = connectionUrl;
    handle.sessionExpires = req => session(req).expires;
    handle.publicOrigin = publicOrigin;
    return handle;
}

module.exports = { createAuthHandler };
