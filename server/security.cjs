const { isIP } = require('node:net');
const { createHmac, randomBytes } = require('node:crypto');

const CSP = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://auth.deriv.com",
    "script-src 'self' 'wasm-unsafe-eval' https://apis.google.com https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    // HTTPS imports and WSS market feeds are supported user-facing features.
    "connect-src 'self' https: wss:",
    "frame-src 'self' https://charts.deriv.com https://accounts.google.com https://docs.google.com https://*.googleapis.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
].join('; ');

function clientAddress(req, trustedProxyHops = 0) {
    const peer = req.socket.remoteAddress || 'unknown';
    if (!trustedProxyHops) return peer;
    const header = req.headers['x-forwarded-for'];
    if (typeof header !== 'string') return peer;
    const chain = [...header.split(',').map(ip => ip.trim()), peer];
    const index = chain.length - 1 - trustedProxyHops;
    return index >= 0 && isIP(chain[index]) ? chain[index] : peer;
}

function tokenBucket(rate, burst, now = Date.now) {
    let tokens = burst,
        at = now();
    return () => {
        const current = now();
        tokens = Math.min(burst, tokens + (Math.max(0, current - at) * rate) / 1000);
        at = current;
        if (tokens < 1) return false;
        tokens--;
        return true;
    };
}

function createSecurity({
    origin,
    secret = randomBytes(32),
    audit = event => console.warn(JSON.stringify(event)),
    sessionIdentity = () => null,
    now = Date.now,
    trustedProxyHops = Number(process.env.NETO_TRUST_PROXY_HOPS ?? (process.env.RENDER === 'true' ? 1 : 0)),
    maxSockets = Number(process.env.NETO_MAX_SOCKETS || 256),
    socketsPerIp = 64,
    socketsPerSession = 16,
    maxBuckets = 10000,
    httpRate = 40,
    httpBurst = 400,
    apiRate = 20,
    apiBurst = 240,
    authRate = 0.5,
    authBurst = 30,
} = {}) {
    if (!Number.isInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5)
        throw new Error('NETO_TRUST_PROXY_HOPS must be an integer from 0 to 5.');
    if (!Number.isInteger(maxSockets) || maxSockets < 1 || maxSockets > 10000)
        throw new Error('NETO_MAX_SOCKETS must be an integer from 1 to 10000.');
    const buckets = new Map(),
        sockets = new Map();
    const logBudget = tokenBucket(1, 30, now);
    const log = (event, req) => {
        if (!logBudget()) return;
        const client = createHmac('sha256', secret)
            .update(clientAddress(req, trustedProxyHops))
            .digest('hex')
            .slice(0, 16);
        try {
            audit({ event, client, at: new Date(now()).toISOString() });
        } catch {
            /* Logging never interrupts trading. */
        }
    };
    let activeSockets = 0,
        activeRequests = 0,
        prunedAt = 0;
    const take = (key, rate, burst) => {
        if (now() - prunedAt >= 60000) {
            for (const [id, value] of buckets) if (now() - value.at > 120000) buckets.delete(id);
            prunedAt = now();
        }
        let value = buckets.get(key);
        if (!value) {
            if (buckets.size >= maxBuckets) return false; // Do not evict a live limit to make room for an attacker.
            value = { consume: tokenBucket(rate, burst, now), at: now() };
            buckets.set(key, value);
        }
        value.at = now();
        return value.consume();
    };
    const headers = res => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        if (origin?.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    };
    return {
        headers,
        log,
        handle(req, res) {
            headers(res);
            let url;
            try {
                url = new URL(req.url, origin || 'http://localhost');
            } catch {
                res.writeHead(400);
                res.end();
                return false;
            }
            const pathname = url.pathname;
            const api = pathname.startsWith('/api/');
            if (api) res.setHeader('Cache-Control', 'no-store');
            const reject = (status, error) => {
                res.setHeader('Cache-Control', 'no-store');
                log(`http_rejected_${status}`, req);
                if (status === 429) res.setHeader('Retry-After', '2');
                res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error }));
                req.resume();
                return false;
            };
            const ip = clientAddress(req, trustedProxyHops);
            if (!take(`http:${ip}`, httpRate, httpBurst))
                return reject(429, 'Too many requests. Please try again shortly.');
            if (api) {
                if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length > 1))
                    return reject(400, 'Duplicate query parameters are not allowed.');
                if (req.headers['sec-fetch-site'] === 'cross-site')
                    return reject(403, 'Use NetoAcademy to access this API.');
                if (Number(req.headers['content-length']) > 8192) return reject(413, 'Request too large.');
                if (pathname !== '/api/health') {
                    const sid = sessionIdentity(req);
                    if (!take(`api:${ip}`, apiRate, apiBurst) || (sid && !take(`session:${sid}`, 4, 40)))
                        return reject(429, 'Too many requests. Please try again shortly.');
                    if (
                        (pathname.startsWith('/api/auth/') || pathname === '/api/connection') &&
                        !take(`auth:${ip}`, authRate, authBurst)
                    )
                        return reject(429, 'Too many login requests. Please try again shortly.');
                }
            }
            if (activeRequests >= 128) return reject(503, 'The service is busy. Please try again shortly.');
            activeRequests++;
            let released = false;
            const release = () => {
                if (!released) {
                    released = true;
                    activeRequests--;
                }
            };
            res.once('finish', release);
            res.once('close', release);
            return true;
        },
        reserveSocket(req) {
            const ip = clientAddress(req, trustedProxyHops),
                sid = sessionIdentity(req);
            if (
                !take(`upgrade:${ip}`, 1, 40) ||
                (sid && !take(`upgrade-session:${sid}`, 1, 16)) ||
                activeSockets >= maxSockets
            ) {
                log('socket_limit', req);
                return;
            }
            const keys = [`ip:${ip}`, ...(sid ? [`sid:${sid}`] : [])];
            if (
                keys.some(key => (sockets.get(key) || 0) >= (key.startsWith('ip:') ? socketsPerIp : socketsPerSession))
            ) {
                log('socket_limit', req);
                return;
            }
            for (const key of keys) sockets.set(key, (sockets.get(key) || 0) + 1);
            activeSockets++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                activeSockets--;
                for (const key of keys) {
                    const count = sockets.get(key) - 1;
                    if (count) sockets.set(key, count);
                    else sockets.delete(key);
                }
            };
        },
        messageLimiter(req) {
            const connection = tokenBucket(50, 100, now);
            const ip = req && clientAddress(req, trustedProxyHops);
            const sid = req && sessionIdentity(req);
            return () =>
                connection() &&
                (!ip || take(`messages:${ip}`, 400, 1200)) &&
                (!sid || take(`session-messages:${sid}`, 200, 600));
        },
    };
}

// Forward only operations supported by the site. Keep operation names separate
// from parameters so a request can never contain a second operation.
const PUBLIC_SOCKET_FIELDS = {
    active_symbols: 'contract_type',
    asset_index: '',
    contracts_for: '',
    exchange_rates: 'base_currency target_currency',
    forget: '',
    forget_all: '',
    payout_currencies: '',
    ping: '',
    proposal: 'amount barrier barrier2 basis cancellation contract_type currency date_expiry duration duration_unit limit_order multiplier selected_tick symbol underlying_symbol growth_rate',
    ticks: '',
    ticks_history: 'adjust_start_time count end granularity start style',
    time: '',
    trading_times: '',
    website_status: '',
};
const PRIVATE_SOCKET_FIELDS = {
    balance: '',
    buy: 'price parameters',
    contract_update: 'contract_id limit_order',
    portfolio: '',
    profit_table: 'date_from date_to description limit offset sort',
    proposal_open_contract: 'contract_id',
    sell: 'price',
    statement: 'action_type date_from date_to description limit offset',
    tnc_approval: '',
    transaction: '',
};
const SOCKET_FIELDS = new Map(
    Object.entries({ ...PUBLIC_SOCKET_FIELDS, ...PRIVATE_SOCKET_FIELDS }).map(([operation, fields]) => [
        operation,
        new Set([operation, 'req_id', 'passthrough', 'subscribe', ...fields.split(' ').filter(Boolean)]),
    ])
);

function validateSocketMessage(body, account) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('A JSON API object is required.');
    const keys = Object.keys(body);
    const operations = keys.filter(key => SOCKET_FIELDS.has(key));
    if (operations.length !== 1 || !keys.every(key => SOCKET_FIELDS.get(operations[0]).has(key)))
        throw new Error('A single supported Deriv API operation is required.');
    const [operation] = operations;
    if (!account && Object.hasOwn(PRIVATE_SOCKET_FIELDS, operation))
        throw new Error('Log in and select an account before sending private trading requests.');
    if (['buy', 'sell', 'contract_update'].includes(operation) && !body[operation])
        throw new Error('A valid trading operation is required.');
}
module.exports = { createSecurity, clientAddress, tokenBucket, validateSocketMessage, CSP };
