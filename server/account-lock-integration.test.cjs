const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const http = require('node:http');
const { createAnalysisService } = require('./analysis.cjs');
const { createTradingStateStorage } = require('./trading-state.cjs');
const { createAccountLocks } = require('./account-locks.cjs');
const { empty } = require('../.server-build/engine');
const databaseUrl = process.env.NETO_TEST_DATABASE_URL;
class PersistedEngine {
    constructor(deps) {
        this.deps = deps;
        this.state = empty();
        this.listeners = new Set();
    }
    selectAccount(account) {
        this.state = {
            ...empty(),
            ...JSON.parse(this.deps.storage.getItem(`neto.digit-strategy.v1.${account.account_id}`) || '{}'),
            accountId: account.account_id,
            active: false,
            wantsRun: false,
        };
    }
    getSnapshot() {
        return this.state;
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    save() {
        this.deps.storage.setItem(
            `neto.digit-strategy.v1.${this.state.accountId}`,
            JSON.stringify({ ...this.state, version: 1 })
        );
        for (const fn of this.listeners) fn();
    }
    async start(settings) {
        this.state = { ...this.state, settings, active: true, wantsRun: true, liveUntil: Date.now() + 15000 };
        this.save();
    }
    stop() {
        this.state = { ...this.state, active: false, wantsRun: false, liveUntil: 0 };
        this.save();
    }
    reset() {
        this.state = { ...empty(), accountId: this.state.accountId };
        this.save();
    }
}
async function fixture(t) {
    const pool = new (require('pg').Pool)({ connectionString: databaseUrl }),
        id = 'CROSS-' + randomUUID(),
        account = { account_id: id, status: 'active', currency: 'USD', account_type: 'demo' },
        services = [],
        servers = [],
        locksList = [];
    const make = async () => {
        const storage = createTradingStateStorage({ databaseUrl }),
            locks = createAccountLocks({ databaseUrl, schedule: () => ({ unref() {} }), cancel() {} });
        locksList.push(locks);
        const service = createAnalysisService(
            {
                publicOrigin: 'http://localhost',
                authorizeAccount: async (_, value) => {
                    assert.equal(value, id);
                    return account;
                },
                connectionUrl: async () => 'wss://example.invalid/private',
                sessionExpires: () => Date.now() + 60000,
            },
            {
                storage,
                locks,
                Engine: PersistedEngine,
                brokerFactory: async () => ({ send: async () => ({ portfolio: { contracts: [] } }), disconnect() {} }),
            }
        );
        services.push(service);
        const server = http.createServer(service.handle);
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        servers.push(server);
        const request = async body => {
            const result = await fetch(`http://127.0.0.1:${server.address().port}/api/analysis?account_id=${id}`, {
                ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
                headers: { origin: 'http://localhost', 'content-type': 'application/json' },
            });
            return { status: result.status, body: await result.json() };
        };
        return { service, locks, request };
    };
    t.after(async () => {
        await Promise.allSettled(services.map(s => s.close()));
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise(r => server.close(r));
        }
        const hash = createHash('sha256').update(id).digest('hex');
        await pool.query('DELETE FROM neto_account_settlements WHERE account_key=$1', [hash]);
        await pool.query('DELETE FROM neto_account_locks WHERE account_key=$1', [hash]);
        await pool.query('DELETE FROM neto_trading_state WHERE state_key=$1', [
            createHash('sha256').update(`neto.digit-strategy.v1.${id}`).digest('hex'),
        ]);
        await pool.end();
    });
    return { id, pool, make };
}
test(
    'independent service instances show one running account, reject a competing start, and deliver remote STOP',
    { skip: !databaseUrl },
    async t => {
        const f = await fixture(t),
            a = await f.make(),
            b = await f.make();
        await a.request({ action: 'start', settings: empty().settings });
        await a.service.sessions.get(f.id).task;
        assert.equal((await b.request()).body.active, true);
        await b.request({ action: 'start', settings: empty().settings });
        await b.service.sessions.get(f.id).task;
        assert.match(b.service.sessions.get(f.id).commandError, /controlled by another/);
        assert.equal(a.service.sessions.get(f.id).engine.getSnapshot().active, true);
        assert.equal((await b.request({ action: 'reset' })).status, 409);
        await b.request({ action: 'stop' });
        await a.locks.heartbeat();
        assert.equal(a.service.sessions.get(f.id).engine.getSnapshot().active, false);
    }
);
test(
    'Builder/XML intents prevent an analysis start on another service until the real provider result settles',
    { skip: !databaseUrl },
    async t => {
        const f = await fixture(t),
            a = await f.make(),
            b = await f.make();
        const outgoing = await a.service.authorizeBuilderBuy(f.id, { buy: 1, price: 0.35, req_id: 1 }, 'device');
        assert.ok(outgoing.passthrough.neto_lock_order);
        await b.request({ action: 'start', settings: empty().settings });
        await b.service.sessions.get(f.id).task;
        assert.match(b.service.sessions.get(f.id).commandError, /unresolved purchase/);
        await a.service.observeBuilder(f.id, { req_id: 1, buy: { contract_id: 4321 } }, 'device');
        await b.service.observeBuilder(
            f.id,
            { proposal_open_contract: { contract_id: 4321, is_sold: 1 } },
            'background'
        );
        await f.pool.query("UPDATE neto_account_locks SET lease_until=NOW()-INTERVAL '1 second' WHERE account_key=$1", [
            createHash('sha256').update(f.id).digest('hex'),
        ]);
        await b.request({ action: 'start', settings: empty().settings });
        await b.service.sessions.get(f.id).task;
        assert.equal(b.service.sessions.get(f.id).engine.getSnapshot().active, true);
    }
);

test(
    'simultaneous Builder clients on one server cannot obtain two purchase permits',
    { skip: !databaseUrl },
    async t => {
        const f = await fixture(t),
            instance = await f.make();
        const results = await Promise.allSettled([
            instance.service.authorizeBuilderBuy(f.id, { buy: 1, price: 0.35, req_id: 1 }, 'phone'),
            instance.service.authorizeBuilderBuy(f.id, { buy: 1, price: 0.35, req_id: 2 }, 'laptop'),
        ]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
    }
);
