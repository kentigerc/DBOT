const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdminAnalytics, reportRange } = require('./admin.cjs');
const { createAnalyticsStore } = require('./analytics-store.cjs');
const appId = require('../config/netoacademy.json').appId;
async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neto-admin-'));
    const store = createAnalyticsStore({ databaseUrl: '', directory });
    const auth = {
        publicOrigin: 'http://localhost:5000',
        sessionIdentity: req => (req.headers.cookie?.includes('login=yes') ? 'session' : null),
        requireAdmin: async req => {
            if (!req.headers.cookie?.includes('owner=yes'))
                throw Object.assign(new Error('Forbidden'), { status: 403 });
        },
        markupStatistics: async () => ({
            data: {
                total_app_markup_usd: 99999,
                breakdown: [
                    { app_id: 'another-app', app_markup_usd: 99999 },
                    { app_id: appId, app_markup_usd: 12.34, volume_usd: 100, contract_count: 10, client_count: 3 },
                ],
            },
        }),
    };
    const analytics = createAdminAnalytics({
        auth,
        store,
        secret: 'test-only-at-least-32-byte-analytics-key',
        activeBots: () => 2,
    });
    const server = http.createServer(analytics.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await analytics.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    let visitor = '';
    const request = async (route, { owner = false, login = false, body, origin = 'http://localhost:5000' } = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                cookie: [visitor, owner ? 'owner=yes' : '', login ? 'login=yes' : ''].filter(Boolean).join('; '),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const cookie = response.headers.getSetCookie()[0];
        if (cookie) visitor = cookie.split(';')[0];
        return response;
    };
    return { analytics, store, request, directory, auth };
}
test('admin data and commission require server authorization; usage rejects foreign origins', async t => {
    const { request } = await fixture(t);
    assert.equal((await request('/api/admin/overview')).status, 403);
    assert.equal((await request('/api/admin/commission')).status, 403);
    assert.equal(
        (await request('/api/analytics/pulse', { body: { tool: 'dashboard' }, origin: 'https://evil.invalid' })).status,
        403
    );
    assert.equal((await request('/api/analytics/pulse', { body: { tool: 'unbounded-user-text' } })).status, 400);
});
test('signed browser heartbeat counts visits once, keeps online counts distinct and stores no raw account IDs', async t => {
    const { analytics, request, store } = await fixture(t);
    const first = await request('/api/analytics/pulse', { body: { tool: 'dashboard' }, login: true });
    assert.equal(first.status, 200);
    assert.match(first.headers.get('set-cookie'), /HttpOnly/);
    await request('/api/analytics/pulse', { body: { tool: 'dashboard' }, login: true });
    await request('/api/analytics/pulse', { body: { tool: 'digit_analysis' }, login: true });
    analytics.accounts([{ account_id: 'PRIVATE-ACCOUNT', account_type: 'real', currency: 'USD', status: 'active' }]);
    await analytics.flush();
    const response = await request('/api/admin/overview', { owner: true });
    const data = await response.json();
    assert.equal(data.visitors, 1);
    assert.equal(data.onlineBrowsers, 1);
    assert.equal(data.onlineAuthenticatedBrowsers, 1);
    assert.equal(data.connectedAccounts, 1);
    assert.equal(data.tools.length, 2);
    assert.equal(data.activeServerBots, 2);
    assert.equal(data.storage, 'preview-file');
    assert.ok(!JSON.stringify(await store.list(0, Date.now() + 1000)).includes('PRIVATE-ACCOUNT'));
});
test('confirmed trades deduplicate buy and settlement messages and keep demo separate from real money', async t => {
    const { analytics, request } = await fixture(t);
    // Distinct verified users: one user's real trading must not hide another's demo.
    analytics.accounts([{ account_id: 'REAL', account_type: 'real', currency: 'USD', status: 'active' }]);
    analytics.accounts([{ account_id: 'DEMO', account_type: 'demo', currency: 'USD', status: 'active' }]);
    for (let i = 0; i < 3; i++) {
        analytics.trade('REAL', 'bot_builder', { contract_id: 123, buy_price: 0.35 });
        analytics.trade('REAL', 'bot_builder', { contract_id: 123, buy_price: 0.35, is_sold: 1, profit: -0.35 });
    }
    analytics.trade('DEMO', 'hit_and_run', { contractId: 456, stake: 74, profit: 67, at: Date.now() });
    await analytics.flush();
    const data = await (await request('/api/admin/overview', { owner: true })).json();
    assert.equal(data.trades, 2);
    assert.equal(data.tradingAccounts, 2);
    assert.deepEqual(
        data.money.find(row => row.accountType === 'real'),
        {
            accountType: 'real',
            currency: 'USD',
            trades: 1,
            volume: 35,
            net: -35,
            settled: 1,
            wins: 0,
            losses: 1,
            open: 0,
        }
    );
    assert.equal(data.money.find(row => row.accountType === 'demo').net, 67);
});
test('commission uses only the configured app row, never the sum of the owner’s other apps', async t => {
    const { request } = await fixture(t);
    const data = await (await request('/api/admin/commission?from=2026-10-01&to=2026-10-26', { owner: true })).json();
    assert.equal(data.source, 'Deriv');
    assert.equal(data.appId, appId);
    assert.equal(data.commissionUsd, 12.34);
});
test('missing or unavailable commission is never replaced with estimated or zero earnings', async t => {
    const { request, auth } = await fixture(t);
    auth.markupStatistics = async () => ({ data: { breakdown: [] } });
    const missing = await (await request('/api/admin/commission', { owner: true })).json();
    assert.equal(missing.reported, false);
    assert.equal(missing.commissionUsd, null);
    auth.markupStatistics = async () => {
        throw Object.assign(new Error('Reporting authorization required.'), { status: 403 });
    };
    assert.equal((await request('/api/admin/commission', { owner: true })).status, 403);
});
test('preview history survives a store restart and invalid date ranges are rejected', async t => {
    const { store, directory, request } = await fixture(t);
    await store.put({ id: 'fixture', kind: 'visit', at: Date.now(), visitor: 'hash' });
    const reopened = createAnalyticsStore({ databaseUrl: '', directory });
    assert.equal((await reopened.list(0, Date.now() + 1000)).length, 1);
    await reopened.close();
    assert.equal((await request('/api/admin/overview?from=2026-02-30&to=2026-03-02', { owner: true })).status, 400);
    assert.throws(() => reportRange(new URL('http://localhost/?from=2020-01-01&to=2026-01-01')), /date range/);
});
test('daily commission requests use exact inclusive UTC buckets and monthly reports do not estimate daily earnings', async t => {
    const { request, auth } = await fixture(t);
    const calls = [];
    auth.markupStatistics = async (req, from, to) => {
        calls.push({ from, to });
        return {
            data: {
                breakdown: [
                    {
                        app_id: appId,
                        app_markup_usd: from === to ? 1 : 3,
                        volume_usd: 10,
                        contract_count: 1,
                        client_count: 1,
                    },
                ],
            },
        };
    };
    const daily = await (
        await request('/api/admin/commission?from=2026-10-01&to=2026-10-03&breakdown=daily', { owner: true })
    ).json();
    assert.equal(daily.commissionUsd, 3);
    assert.equal(daily.points.length, 3);
    assert.equal(daily.points[0].commissionUsd, 1);
    assert.ok(calls.some(call => call.from === '2026-10-02' && call.to === '2026-10-02'));
    assert.equal(
        (await request('/api/admin/commission?from=2026-01-01&to=2026-03-01&breakdown=daily', { owner: true })).status,
        400
    );
    const monthly = await (
        await request('/api/admin/commission?from=2026-01-15&to=2026-02-10&breakdown=monthly', { owner: true })
    ).json();
    assert.deepEqual(
        monthly.points.map(point => [point.from, point.to]),
        [
            ['2026-01-15', '2026-01-31'],
            ['2026-02-01', '2026-02-10'],
        ]
    );
});

test('per-account activity separates users, currencies and demo; settlements count once', () => {
    const { aggregate } = require('./admin.cjs');
    const base = {
        kind: 'trade',
        at: Date.now(),
        tool: 'bot_builder',
        accountType: 'real',
        currency: 'USD',
        stake: 35,
    };
    const events = [
        { ...base, account: 'user-a', contract: 'one' },
        { ...base, account: 'user-a', contract: 'one', profit: 12 },
        { ...base, account: 'user-a', contract: 'one', profit: 12 },
        { ...base, account: 'user-b', contract: 'two', profit: -35 },
        { ...base, account: 'user-a', contract: 'three', accountType: 'demo' },
        { ...base, account: 'user-a', contract: 'four', currency: 'EUR', stake: 50 },
    ];
    const result = aggregate(events);
    assert.equal(result.tradingUsers.length, 4);
    const userA = result.tradingUsers.find(
        row => row.account === 'user-a' && row.accountType === 'real' && row.currency === 'USD'
    );
    assert.deepEqual(userA, {
        account: 'user-a',
        accountType: 'real',
        currency: 'USD',
        trades: 1,
        volume: 35,
        net: 12,
        settled: 1,
        wins: 1,
        losses: 0,
        open: 0,
    });
    assert.equal(result.tradingUsers.find(row => row.account === 'user-b').losses, 1);
    assert.equal(result.tradingUsers.find(row => row.accountType === 'demo').open, 1);
    assert.equal(
        result.tradingUsers.reduce((sum, row) => sum + row.trades, 0),
        result.trades
    );
    assert.deepEqual(aggregate([]).tradingUsers, []);
    assert.equal(JSON.stringify(result.tradingUsers).includes('commission'), false);
});

test('purchase ownership repairs historical cross-tool settlements in either database order', () => {
    const { aggregate } = require('./admin.cjs');
    const base = { kind: 'trade', at: Date.now(), account: 'demo-user', accountType: 'demo', currency: 'USD' };
    const purchase = { ...base, contract: 'recovery-win', tool: 'hit_and_run', stake: 1439 };
    // Old background Builder streams could win the idempotent settlement write race.
    const settlement = { ...purchase, tool: 'bot_builder', profit: 1266 };
    const loss = { ...base, contract: 'normal-loss', tool: 'hit_and_run', stake: 35, profit: -35 };
    const otherTool = { ...base, contract: 'analysis-win', tool: 'analysis_tool', stake: 74 };
    const otherSettlement = { ...otherTool, tool: 'bot_builder', profit: 65 };
    for (const events of [
        [purchase, settlement, loss, otherTool, otherSettlement],
        [otherSettlement, loss, settlement, otherTool, purchase],
    ]) {
        const result = aggregate(events);
        assert.equal(
            result.tradingTools.some(row => row.tool === 'bot_builder'),
            false
        );
        assert.equal(result.tradingTools.find(row => row.tool === 'hit_and_run').net, 1231);
        assert.equal(result.tradingTools.find(row => row.tool === 'hit_and_run').volume, 1474);
        assert.equal(result.tradingTools.find(row => row.tool === 'analysis_tool').net, 65);
        assert.equal(result.money[0].net, 1296);
        assert.equal(result.tradingUsers[0].net, 1296);
        assert.equal(result.trades, 3);
        assert.equal(result.money[0].settled, 3);
    }
});

test('live settlement attribution follows the confirmed purchase rather than its observing socket', async t => {
    const { analytics, request, store } = await fixture(t);
    analytics.accounts([{ account_id: 'DEMO', account_type: 'demo', currency: 'USD', status: 'active' }]);
    analytics.trade('DEMO', 'hit_and_run', { contract_id: 987, buy_price: 14.39 });
    analytics.trade('DEMO', 'bot_builder', { contract_id: 987, buy_price: 14.39, is_sold: 1, profit: 12.66 });
    analytics.trade('DEMO', 'hit_and_run', { contract_id: 987, buy_price: 14.39, is_sold: 1, profit: 12.66 });
    await analytics.flush();
    const result = await (await request('/api/admin/overview', { owner: true })).json();
    assert.equal(result.tradingTools.length, 1);
    assert.equal(result.tradingTools[0].tool, 'hit_and_run');
    assert.equal(result.tradingTools[0].net, 1266);
    assert.equal(result.trades, 1);
    const events = await store.list(0, Date.now() + 1000);
    assert.equal(events.find(event => event.profit !== undefined).tool, 'hit_and_run');
});

test('real trading hides only that verified user’s demo trades across all dashboard totals', async t => {
    const { analytics, request, store } = await fixture(t);
    analytics.accounts([
        { account_id: 'SAME-DEMO', account_type: 'demo', currency: 'USD', status: 'active' },
        { account_id: 'SAME-REAL', account_type: 'real', currency: 'USD', status: 'active' },
    ]);
    analytics.accounts([{ account_id: 'OTHER-DEMO', account_type: 'demo', currency: 'USD', status: 'active' }]);
    analytics.trade('SAME-DEMO', 'hit_and_run', { contractId: 801, stake: 35, profit: 12 });
    analytics.trade('OTHER-DEMO', 'bot_builder', { contractId: 802, stake: 35, profit: -35 });
    await analytics.flush();
    let result = await (await request('/api/admin/overview', { owner: true })).json();
    assert.equal(result.trades, 2); // Merely owning or selecting a real account does not switch reporting.
    assert.equal(result.hiddenDemoTrades, 0);
    analytics.trade('SAME-REAL', 'analysis_tool', { contractId: 803, stake: 74 });
    await analytics.flush();
    result = await (await request('/api/admin/overview', { owner: true })).json();
    assert.equal(result.trades, 2);
    assert.equal(result.hiddenDemoTrades, 1);
    assert.equal(result.tradingAccounts, 2);
    assert.equal(result.tradingUsers.length, 2);
    assert.equal(
        result.tradingTools.some(row => row.tool === 'hit_and_run'),
        false
    );
    assert.equal(
        result.daily.reduce((n, row) => n + row.trades, 0),
        2
    );
    assert.equal(result.money.find(row => row.accountType === 'demo').net, -35);
    assert.equal(result.money.find(row => row.accountType === 'real').open, 1);
    // Switching back to demo does not restore it in the owner dashboard.
    analytics.trade('SAME-DEMO', 'hit_and_run', { contractId: 804, stake: 35, profit: 12 });
    await analytics.flush();
    result = await (await request('/api/admin/overview', { owner: true })).json();
    assert.equal(result.hiddenDemoTrades, 2);
    assert.equal(result.trades, 2);
    const records = await store.list(0, Date.now() + 1000);
    assert.equal(records.filter(row => row.kind === 'trade').length, 4); // History is retained.
    assert.equal(JSON.stringify(records).includes('SAME-DEMO'), false);
});

test('real trading outside the date filter still hides linked demo history after restart', async t => {
    const { analytics, request, store, directory } = await fixture(t);
    analytics.accounts([
        { account_id: 'PAST-REAL', account_type: 'real', currency: 'USD', status: 'active' },
        { account_id: 'CURRENT-DEMO', account_type: 'demo', currency: 'USD', status: 'active' },
    ]);
    analytics.trade('PAST-REAL', 'bot_builder', {
        contractId: 901,
        stake: 35,
        profit: 12,
        at: Date.now() - 40 * 86400000,
    });
    analytics.trade('CURRENT-DEMO', 'hit_and_run', { contractId: 902, stake: 35, profit: 12 });
    await analytics.flush();
    const result = await (await request('/api/admin/overview', { owner: true })).json();
    assert.equal(result.trades, 0);
    assert.equal(result.hiddenDemoTrades, 1);
    const { hiddenDemoAccounts } = require('./admin.cjs');
    const reopened = createAnalyticsStore({ databaseUrl: '', directory });
    t.after(() => reopened.close());
    assert.equal(hiddenDemoAccounts(await reopened.tradingVisibility()).size, 1);
    assert.equal((await store.list(0, Date.now() + 1000)).filter(row => row.kind === 'trade').length, 2);
});

test('verified account links join transitively without matching unrelated users', () => {
    const { hiddenDemoAccounts } = require('./admin.cjs');
    const group = members => ({ kind: 'account_group', members });
    const demo = account => ({ account, accountType: 'demo' });
    const real = account => ({ account, accountType: 'real' });
    const history = [
        group([demo('demo-one'), real('real-usd')]),
        group([demo('demo-two'), real('real-eur')]),
        group([real('real-usd'), real('real-eur')]),
        group([demo('unrelated'), real('not-trading')]),
        { kind: 'real_account', account: 'real-eur' },
    ];
    assert.deepEqual([...hiddenDemoAccounts(history)].sort(), ['demo-one', 'demo-two']);
    assert.deepEqual([...hiddenDemoAccounts([...history].reverse())].sort(), ['demo-one', 'demo-two']);
});
