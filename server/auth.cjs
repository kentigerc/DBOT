const { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const configuration = require('../config/netoacademy.json');

const AUTH_ORIGIN = 'https://auth.deriv.com';
const API_ORIGIN = 'https://api.derivws.com';
const SESSION_COOKIE = 'neto_session';
const FLOW_COOKIE = 'neto_oauth';
const REFRESH_COOKIE = 'neto_refresh';
const REPORTING_COOKIE = 'neto_reporting';
const REFRESH_SECONDS = 7 * 24 * 60 * 60;

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
    onAccounts = () => {},
    adminAccountIds = (process.env.NETO_ADMIN_ACCOUNT_IDS || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean),
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
    const renewed = new Map();
    const renewing = new Map();
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
    async function requestJson(url, options, refresh = false, reporting = false) {
        let response;
        try {
            response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
        } catch {
            throw new HttpError(502, 'Unable to reach Deriv. Please try again.');
        }
        // Do not forward upstream bodies: they can contain credentials or authorization codes.
        if (!response.ok) {
            if (reporting && response.status === 403)
                throw new HttpError(403, 'Connect your developer reporting authorization to view commission.');
            if (refresh && response.status === 400) {
                const body = await response.json().catch(() => ({}));
                if (['invalid_grant', 'invalid_token'].includes(body.error))
                    throw new HttpError(401, 'Your Deriv session expired. Please log in again.');
            }
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
            headers: { Authorization: `Bearer ${token}`, 'Deriv-App-ID': configuration.appId },
        });
        if (!Array.isArray(result.data)) throw new HttpError(502, 'Deriv returned an unexpected accounts response.');
        const accounts = result.data
            .map(account => ({
                account_id: account.account_id,
                account_type: account.account_type,
                currency: account.currency,
                balance: account.balance,
                status: account.status,
            }))
            .filter(account => typeof account.account_id === 'string');
        try {
            onAccounts(accounts);
        } catch {
            /* Analytics must never affect authorization. */
        }
        return accounts;
    }
    function session(req) {
        const cookie = readCookie(req, SESSION_COOKIE);
        const refresh = readCookie(req, REFRESH_COOKIE);
        const cached = renewed.get(cookie?.sid || refresh?.sid);
        if (cached?.revoked) throw new HttpError(401, 'Please log in to Deriv.');
        const value = cached?.session || cookie;
        if (!value?.access_token || value.expires <= now()) throw new HttpError(401, 'Please log in to Deriv.');
        return value;
    }
    function tokenSeconds(tokens) {
        if (
            typeof tokens.access_token !== 'string' ||
            !tokens.access_token ||
            tokens.access_token.length > 2000 ||
            !Number.isFinite(Number(tokens.expires_in)) ||
            Number(tokens.expires_in) < 1
        )
            throw new HttpError(502, 'Deriv returned an invalid session.');
        return Math.min(Math.floor(Number(tokens.expires_in)), REFRESH_SECONDS);
    }
    function accessSession(tokens, sid, seconds) {
        return {
            sid,
            access_token: tokens.access_token,
            expires: now() + seconds * 1000,
            renewAt: now() + (seconds - Math.min(120, seconds / 3)) * 1000,
        };
    }
    function refreshData(tokens, sid, previous) {
        const token = tokens.refresh_token ?? previous?.refresh_token;
        if (token === undefined) return undefined;
        if (typeof token !== 'string' || !token || token.length > 2000)
            throw new HttpError(502, 'Deriv returned an invalid renewal credential.');
        // An absolute seven-day bound; renewal never rolls this deadline forward.
        return { sid, refresh_token: token, expires: previous?.expires || now() + REFRESH_SECONDS * 1000 };
    }
    function writeSession(res, saved, refresh) {
        setCookie(res, SESSION_COOKIE, saved, Math.max(1, Math.floor((saved.expires - now()) / 1000)));
        if (refresh) setCookie(res, REFRESH_COOKIE, refresh, Math.max(1, Math.floor((refresh.expires - now()) / 1000)));
    }
    async function browserSession(req, res) {
        const refreshCookie = readCookie(req, REFRESH_COOKIE);
        const cookie = readCookie(req, SESSION_COOKIE);
        const sid = cookie?.sid || refreshCookie?.sid;
        let cached = renewed.get(sid);
        if (cached?.revoked) throw new HttpError(401, 'Please log in to Deriv.');
        let saved = cached?.session || cookie;
        const refresh = cached?.refresh || (refreshCookie?.sid === sid ? refreshCookie : undefined);
        if (refresh && refresh.expires > now() && (!saved || now() >= (saved.renewAt ?? saved.expires - 120000))) {
            if (!renewing.has(sid)) {
                const task = (async () => {
                    for (const [id, value] of renewed) if (value.until <= now()) renewed.delete(id);
                    if (!renewed.has(sid) && renewed.size >= 2000)
                        throw new HttpError(503, 'Session renewal is busy. Please try again.');
                    const tokens = await requestJson(
                        `${AUTH_ORIGIN}/oauth2/token`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({
                                grant_type: 'refresh_token',
                                client_id: configuration.appId,
                                refresh_token: refresh.refresh_token,
                            }).toString(),
                        },
                        true
                    );
                    const seconds = Math.min(tokenSeconds(tokens), Math.floor((refresh.expires - now()) / 1000));
                    if (seconds < 1) throw new HttpError(401, 'Please log in to Deriv.');
                    const result = {
                        session: accessSession(tokens, sid, seconds),
                        refresh: refreshData(tokens, sid, refresh),
                        until: refresh.expires,
                    };
                    if (renewed.get(sid)?.revoked) throw new HttpError(401, 'Please log in to Deriv.');
                    renewed.set(sid, result);
                    return result;
                })();
                renewing.set(sid, task);
            }
            try {
                cached = await renewing.get(sid);
            } finally {
                renewing.delete(sid);
            }
            // Logout while an upstream renewal was in flight must not restore login.
            if (renewed.get(sid)?.revoked) throw new HttpError(401, 'Please log in to Deriv.');
            saved = cached.session;
            writeSession(res, saved, cached.refresh);
        } else if (cached?.session && cookie?.access_token !== cached.session.access_token) {
            saved = cached.session;
            writeSession(res, saved, cached.refresh);
        }
        return saved?.access_token && saved.expires > now() ? saved : null;
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
                headers: { Authorization: `Bearer ${saved.access_token}`, 'Deriv-App-ID': configuration.appId },
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
                const adminLogin = url.searchParams.get('admin') === '1';
                const adminOwner = adminLogin ? (await handle.requireAdmin(req)).sid : undefined;
                const verifier = randomBytes(48).toString('base64url');
                const state = randomBytes(32).toString('base64url');
                setCookie(
                    res,
                    FLOW_COOKIE,
                    {
                        verifier,
                        state,
                        admin: adminLogin,
                        adminOwner,
                        returnTo: adminLogin || url.searchParams.get('return') === 'admin' ? '/admin' : '/',
                        expires: now() + 600000,
                    },
                    600
                );
                const auth = new URL('/oauth2/auth', AUTH_ORIGIN);
                auth.search = new URLSearchParams({
                    response_type: 'code',
                    client_id: configuration.appId,
                    redirect_uri: redirectUri,
                    scope: adminLogin ? 'application_read' : 'trade',
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
                if (flow.admin && (await handle.requireAdmin(req)).sid !== flow.adminOwner)
                    throw new HttpError(403, 'The owner session changed. Start reporting login again.');
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
                const seconds = tokenSeconds(tokens);
                if (flow.admin) {
                    setCookie(
                        res,
                        REPORTING_COOKIE,
                        { access_token: tokens.access_token, expires: now() + seconds * 1000 },
                        seconds
                    );
                    return json(res, 200, { authenticated: true, returnTo: '/admin' });
                }
                setCookie(res, REPORTING_COOKIE, null, 0);
                const sid = randomBytes(24).toString('base64url');
                const refresh = refreshData(tokens, sid);
                setCookie(res, REFRESH_COOKIE, null, 0);
                writeSession(res, accessSession(tokens, sid, seconds), refresh);
                return json(res, 200, {
                    authenticated: true,
                    returnTo: flow.admin || flow.returnTo === '/admin' ? '/admin' : '/',
                });
            }
            if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
                setCookie(res, REPORTING_COOKIE, null, 0);
                const value = readCookie(req, SESSION_COOKIE) || readCookie(req, REFRESH_COOKIE);
                if (value?.sid) renewed.set(value.sid, { revoked: true, until: now() + REFRESH_SECONDS * 1000 });
                setCookie(res, REFRESH_COOKIE, null, 0);
                setCookie(res, SESSION_COOKIE, null, 0);
                setCookie(res, FLOW_COOKIE, null, 0);
                return json(res, 200, { authenticated: false });
            }
            if (url.pathname === '/api/session' && req.method === 'GET') {
                const saved = await browserSession(req, res);
                if (!saved?.access_token) return json(res, 200, { authenticated: false, accounts: [] });
                const accounts = await getAccounts(saved.access_token);
                const adminAccounts = accounts
                    .filter(account => account.status === 'active' && adminAccountIds.includes(account.account_id))
                    .map(account => account.account_id);
                return json(res, 200, {
                    authenticated: true,
                    accounts,
                    isAdmin: adminAccounts.length > 0,
                    adminAccounts,
                    expiresAt: saved.expires,
                    renewable: !!readCookie(req, REFRESH_COOKIE),
                });
            }
            if (url.pathname === '/api/connection' && req.method === 'POST') {
                const { account_id } = await readBody(req);
                return json(res, 200, { url: await connectionUrl(req, account_id) });
            }
            return json(res, 404, { error: 'API route not found.' });
        } catch (error) {
            if (error.status === 401) {
                setCookie(res, SESSION_COOKIE, null, 0);
                setCookie(res, REFRESH_COOKIE, null, 0);
            }
            return json(res, error.status || 500, {
                error: error.status ? error.message : 'Unable to complete the request.',
            });
        }
    };
    const accountCache = new Map();
    const reportCache = new Map();
    const cachedAccounts = async saved => {
        const cacheKey = createHash('sha256').update(saved.access_token).digest('hex');
        let cached = accountCache.get(cacheKey);
        if (!cached || cached.until < now()) {
            cached = { accounts: await getAccounts(saved.access_token), until: now() + 30000 };
            if (accountCache.size > 1000) accountCache.clear();
            accountCache.set(cacheKey, cached);
        }
        return cached.accounts;
    };
    handle.authorizeAccount = async (req, accountId) => {
        const accounts = await cachedAccounts(session(req));
        const account = accounts.find(item => item.account_id === accountId && item.status === 'active');
        if (!account) throw new HttpError(403, 'This trading account is not available in your Deriv session.');
        return account;
    };
    handle.requireAdmin = async req => {
        if (!adminAccountIds.length)
            throw new HttpError(503, 'Admin access is not configured. Set NETO_ADMIN_ACCOUNT_IDS on the server.');
        const saved = session(req);
        const accounts = await cachedAccounts(saved);
        if (!accounts.some(account => account.status === 'active' && adminAccountIds.includes(account.account_id)))
            throw new HttpError(403, 'This account does not have admin access.');
        return saved;
    };
    handle.markupStatistics = async (req, from, to) => {
        await handle.requireAdmin(req);
        const saved = readCookie(req, REPORTING_COOKIE);
        if (!saved?.access_token)
            throw new HttpError(403, 'Connect your developer reporting authorization to view commission.');
        const cacheKey = createHash('sha256').update(saved.access_token).digest('hex') + ':' + from + ':' + to;
        const cached = reportCache.get(cacheKey);
        if (cached && cached.until > now()) return cached.result;
        const url = new URL('/applications/v1/markup-statistics', API_ORIGIN);
        url.search = new URLSearchParams({ date_from: from, date_to: to }).toString();
        try {
            const result = await requestJson(
                url.toString(),
                { headers: { Authorization: `Bearer ${saved.access_token}`, 'Deriv-App-ID': configuration.appId } },
                false,
                true
            );
            for (const [key, value] of reportCache) if (value.until <= now()) reportCache.delete(key);
            if (reportCache.size >= 1000) reportCache.delete(reportCache.keys().next().value);
            const checked = { ...result, checkedAt: now() };
            reportCache.set(cacheKey, { until: now() + 60000, result: checked });
            return checked;
        } catch (error) {
            if (error.status === 401)
                throw new HttpError(403, 'Developer reporting authorization expired. Connect reporting again.');
            throw error;
        }
    };
    handle.sessionIdentity = req => {
        try {
            const saved = session(req);
            return saved.sid || null;
        } catch {
            return null;
        }
    };
    handle.connectionUrl = connectionUrl;
    handle.sessionExpires = req => session(req).expires;
    handle.publicOrigin = publicOrigin;
    return handle;
}

module.exports = { createAuthHandler };
