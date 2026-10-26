const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const configuration = require('../config/netoacademy.json');
const TOOLS = new Set([
    'dashboard',
    'bot_builder',
    'chart',
    'digit_analysis',
    'deriv_charts',
    'free_bots',
    'analysis_tool',
    'hit_and_run',
]);
const day = at => new Date(at).toISOString().slice(0, 10);
function reportRange(url) {
    const end = url.searchParams.get('to') || day(Date.now());
    const start = url.searchParams.get('from') || day(Date.now() - 29 * 86400000);
    const parse = value => {
        const date = Date.parse(value);
        return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date) && day(date) === value ? date : NaN;
    };
    const from = parse(start),
        to = parse(end) + 86400000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 366 * 86400000)
        throw Object.assign(new Error('Choose a valid date range of up to 366 days (UTC).'), { status: 400 });
    return { start, end, from, to };
}
function aggregate(events) {
    const visitors = new Set(),
        accounts = new Set(),
        traders = new Set(),
        daily = new Map(),
        tools = new Map(),
        money = new Map(),
        tradingTools = new Map(),
        tradingUsers = new Map(),
        contracts = new Map(),
        purchases = new Map();
    const bucket = at => {
        const date = day(at);
        if (!daily.has(date)) daily.set(date, { date, visitors: 0, connections: 0, trades: 0 });
        return daily.get(date);
    };
    for (const event of events) {
        if (event.kind === 'visit') {
            visitors.add(event.visitor);
            bucket(event.at).visitors++;
        }
        if (event.kind === 'account') {
            accounts.add(event.account);
            bucket(event.at).connections++;
        }
        if (event.kind === 'usage') tools.set(event.tool, (tools.get(event.tool) || 0) + 1);
        if (event.kind === 'trade') {
            contracts.set(event.contract, { ...contracts.get(event.contract), ...event });
            if (event.profit === undefined) purchases.set(event.contract, event);
        }
    }
    for (const record of contracts.values()) {
        // Account-wide subscriptions can observe another tool's settlement. The
        // purchase identifies its owner, regardless of SQL ordering at equal timestamps.
        const event = {
            ...record,
            ...purchases.get(record.contract),
            ...(record.profit !== undefined ? { profit: record.profit } : {}),
        };
        traders.add(event.account);
        bucket(event.at).trades++;
        for (const groups of [money, tradingTools, tradingUsers]) {
            const key = `${groups === tradingTools ? event.tool + ':' : groups === tradingUsers ? event.account + ':' : ''}${event.accountType}:${event.currency}`;
            if (!groups.has(key))
                groups.set(key, {
                    ...(groups === tradingTools ? { tool: event.tool } : {}),
                    ...(groups === tradingUsers ? { account: event.account } : {}),
                    accountType: event.accountType,
                    currency: event.currency,
                    trades: 0,
                    volume: 0,
                    net: 0,
                    settled: 0,
                    wins: 0,
                    losses: 0,
                    open: 0,
                });
            const group = groups.get(key);
            group.trades++;
            group.volume += event.stake;
            if (event.profit !== undefined) {
                group.net += event.profit;
                group.settled++;
                if (event.profit > 0) group.wins++;
                if (event.profit < 0) group.losses++;
            } else group.open++;
        }
    }
    return {
        visitors: visitors.size,
        connectedAccounts: accounts.size,
        tradingAccounts: traders.size,
        trades: contracts.size,
        daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
        tools: [...tools].map(([tool, sessions]) => ({ tool, sessions })).sort((a, b) => b.sessions - a.sessions),
        money: [...money.values()],
        tradingTools: [...tradingTools.values()],
        tradingUsers: [...tradingUsers.values()].sort(
            (a, b) => b.volume - a.volume || a.account.localeCompare(b.account)
        ),
    };
}
function commissionRow(result) {
    const rows = result.data?.breakdown;
    if (!Array.isArray(rows)) throw new Error('Invalid reporting response');
    const row = rows.find(row => String(row.app_id) === configuration.appId);
    if (row) {
        for (const field of ['app_markup_usd', 'volume_usd'])
            if (row[field] === null || row[field] === '' || !Number.isFinite(Number(row[field])))
                throw new Error('Invalid reporting amount');
        for (const field of ['contract_count', 'client_count'])
            if (
                row[field] === null ||
                row[field] === '' ||
                !Number.isSafeInteger(Number(row[field])) ||
                Number(row[field]) < 0
            )
                throw new Error('Invalid reporting count');
    }
    return {
        reported: !!row,
        commissionUsd: row ? Number(row.app_markup_usd) : null,
        volumeUsd: row ? Number(row.volume_usd) : null,
        contracts: row ? Number(row.contract_count) : null,
        clients: row ? Number(row.client_count) : null,
    };
}
function commissionBuckets(range, mode) {
    if (!['none', 'daily', 'monthly'].includes(mode))
        throw Object.assign(new Error('Unknown commission breakdown.'), { status: 400 });
    const buckets = [];
    if (mode === 'none') return buckets;
    if (mode === 'daily' && (range.to - range.from) / 86400000 > 31)
        throw Object.assign(
            new Error('Daily commission breakdown is limited to 31 days. Choose a shorter range or monthly.'),
            { status: 400 }
        );
    for (let at = range.from; at < range.to; ) {
        const date = new Date(at);
        const next = mode === 'daily' ? at + 86400000 : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
        const end = Math.min(next, range.to);
        buckets.push({ from: day(at), to: day(end - 1) });
        at = end;
    }
    return buckets;
}
function createAdminAnalytics({ auth, store, secret, activeBots = () => 0, now = Date.now }) {
    const hash = value => createHmac('sha256', secret).update(String(value)).digest('hex');
    const connections = new Map();
    const online = new Map(),
        accountInfo = new Map(),
        tradeInfo = new Map(),
        queue = new Map(),
        seen = new Set();
    let retry;
    let droppedEvents = 0;
    let draining;
    function flush() {
        if (draining) return draining;
        draining = (async () => {
            let processed = 0;
            for (const [id, event] of queue) {
                if (processed++ >= 1000) break;
                await store.put(event);
                queue.delete(id);
                seen.add(id);
                if (seen.size > 20000) seen.delete(seen.values().next().value);
            }
        })()
            .catch(() => {
                /* Retry without interrupting trading. */
            })
            .finally(() => {
                draining = null;
            });
        return draining;
    }
    function enqueue(event) {
        if (!seen.has(event.id)) {
            if (queue.size < 10000 || queue.has(event.id)) queue.set(event.id, event);
            else droppedEvents++;
        }
        void flush();
    }
    function pruneOnline() {
        for (const [id, value] of online) if (now() - value.at > 90000) online.delete(id);
    }
    retry = setInterval(() => {
        pruneOnline();
        void flush();
    }, 10000);
    retry.unref?.();
    const cleanup = setInterval(() => {
        void store.prune().catch(() => {});
    }, 86400000);
    cleanup.unref?.();
    function accounts(values) {
        for (const account of values.filter(value => value.status === 'active')) {
            accountInfo.set(account.account_id, {
                accountType: ['real', 'demo'].includes(account.account_type) ? account.account_type : 'unknown',
                currency: /^[A-Z]{3,8}$/.test(account.currency) ? account.currency : 'UNKNOWN',
            });
            if (accountInfo.size > 10000) accountInfo.delete(accountInfo.keys().next().value);
            const key = hash(account.account_id);
            enqueue({ id: `account:${day(now())}:${key}`, kind: 'account', at: now(), account: key });
        }
    }
    function trade(accountId, tool, raw) {
        const id = raw.contractId ?? raw.contract_id;
        if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return;
        const multiplier = raw.contractId !== undefined ? 1 : 100;
        const stake = Math.round(Number(raw.stake ?? raw.buy_price) * multiplier);
        if (!Number.isSafeInteger(stake) || stake < 0) return;
        const profit = raw.profit === undefined ? undefined : Math.round(Number(raw.profit) * multiplier);
        if (profit !== undefined && !Number.isSafeInteger(profit)) return;
        const account = hash(accountId),
            contract = hash(`${accountId}:${id}`),
            settled = profit !== undefined;
        const previous = tradeInfo.get(contract);
        const sourceTool = settled ? previous?.tool || tool : tool;
        const at =
            previous?.at ??
            (Number.isFinite(raw.at) ? raw.at : Number.isFinite(raw.date_start) ? raw.date_start * 1000 : now());
        tradeInfo.set(contract, { at, tool: sourceTool });
        if (tradeInfo.size > 20000) tradeInfo.delete(tradeInfo.keys().next().value);
        enqueue({
            id: `trade:${contract}:${settled ? 'settled' : 'buy'}`,
            kind: 'trade',
            at,
            account,
            contract,
            tool: sourceTool,
            stake,
            ...(settled ? { profit } : {}),
            ...(accountInfo.get(accountId) || { accountType: 'unknown', currency: 'UNKNOWN' }),
        });
    }
    const json = (res, status, data) => {
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(data));
    };
    async function handle(req, res) {
        try {
            const url = new URL(req.url, auth.publicOrigin);
            if (url.pathname === '/api/analytics/pulse') {
                if (req.method !== 'POST' || req.headers.origin !== auth.publicOrigin)
                    throw Object.assign(new Error('Invalid request origin.'), { status: 403 });
                if (!req.headers['content-type']?.startsWith('application/json'))
                    throw Object.assign(new Error('JSON required.'), { status: 415 });
                let raw = '';
                for await (const part of req) {
                    raw += part;
                    if (Buffer.byteLength(raw) > 1024)
                        throw Object.assign(new Error('Request too large.'), { status: 413 });
                }
                let body;
                try {
                    body = JSON.parse(raw);
                } catch {
                    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
                }
                if (!TOOLS.has(body.tool)) throw Object.assign(new Error('Unknown page.'), { status: 400 });
                const cookie = (req.headers.cookie || '')
                    .split(';')
                    .map(p => p.trim())
                    .find(p => p.startsWith('neto_visitor='))
                    ?.slice(13);
                let id;
                if (cookie) {
                    const [candidate, signature] = cookie.split('.');
                    const expected = hash(candidate);
                    if (
                        /^[a-f0-9]{32}$/.test(candidate) &&
                        signature?.length === expected.length &&
                        timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
                    )
                        id = candidate;
                }
                if (!id) {
                    id = randomBytes(16).toString('hex');
                    res.setHeader(
                        'Set-Cookie',
                        `neto_visitor=${id}.${hash(id)}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=7776000${auth.publicOrigin.startsWith('https:') ? '; Secure' : ''}`
                    );
                }
                pruneOnline();
                const visitor = hash(id),
                    prior = online.get(visitor);
                if (prior && prior.tool === body.tool && now() - prior.at < 15000) return json(res, 200, { ok: true });
                if (online.size >= 10000) online.delete(online.keys().next().value);
                const authenticated = auth.sessionIdentity(req) !== null;
                online.set(visitor, { at: now(), authenticated, tool: body.tool });
                enqueue({ id: `visit:${day(now())}:${visitor}`, kind: 'visit', at: now(), visitor });
                enqueue({
                    id: `usage:${day(now())}:${visitor}:${body.tool}`,
                    kind: 'usage',
                    at: now(),
                    tool: body.tool,
                    visitor,
                });
                return json(res, 200, { ok: true });
            }
            await auth.requireAdmin(req);
            if (req.method !== 'GET') throw Object.assign(new Error('Method not allowed.'), { status: 405 });
            if (url.pathname === '/api/admin/access') return json(res, 200, { admin: true });
            const range = reportRange(url);
            if (url.pathname === '/api/admin/commission') {
                const mode = url.searchParams.get('breakdown') || 'none';
                const buckets = commissionBuckets(range, mode);
                const result = await auth.markupStatistics(req, range.start, range.end);
                const total = commissionRow(result);
                const points = [];
                // Only an explicit owner request loads history; cap parallel reporting calls.
                for (let index = 0; index < buckets.length; index += 2) {
                    points.push(
                        ...(await Promise.all(
                            buckets.slice(index, index + 2).map(async bucket => ({
                                ...bucket,
                                ...commissionRow(await auth.markupStatistics(req, bucket.from, bucket.to)),
                            }))
                        ))
                    );
                }
                return json(res, 200, {
                    source: 'Deriv',
                    appId: configuration.appId,
                    from: range.start,
                    to: range.end,
                    fetchedAt: result.checkedAt || now(),
                    ...total,
                    points,
                    breakdown: mode,
                });
            }
            if (url.pathname !== '/api/admin/overview') throw Object.assign(new Error('Not found.'), { status: 404 });
            await flush();
            pruneOnline();
            const data = aggregate(await store.list(range.from, range.to));
            return json(res, 200, {
                ...data,
                from: range.start,
                to: range.end,
                liveDerivConnections: connections.size,
                liveConnectedAccounts: new Set(connections.values()).size,
                activeServerBots: activeBots(),
                onlineBrowsers: online.size,
                onlineAuthenticatedBrowsers: [...online.values()].filter(v => v.authenticated).length,
                storage: store.mode,
                healthy: store.health() && droppedEvents === 0,
                droppedEvents,
                pendingEvents: queue.size,
                generatedAt: now(),
            });
        } catch (error) {
            return json(res, error.status || 503, {
                error: error.status ? error.message : 'Analytics or reporting is temporarily unavailable.',
            });
        }
    }
    return {
        handle,
        accounts,
        trade,
        connection(account, key, open) {
            if (open) connections.set(key, hash(account));
            else connections.delete(key);
        },
        flush,
        close: async () => {
            clearInterval(retry);
            clearInterval(cleanup);
            await flush();
            await store.close();
        },
    };
}
module.exports = { createAdminAnalytics, aggregate, reportRange };
