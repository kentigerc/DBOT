const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createTradingStateStorage } = require('./trading-state.cjs');
const { DigitStrategyEngine, empty } = require('../.server-build/engine');
const databaseUrl = process.env.NETO_TEST_DATABASE_URL;
const hash = key => createHash('sha256').update(key).digest('hex');
const pgTest = (name, fn) => test(name, { skip: !databaseUrl }, fn);
async function fixture(t) {
    const pool = new (require('pg').Pool)({ connectionString: databaseUrl });
    const id = 'TEST-' + randomUUID(),
        key = `neto.digit-strategy.v1.${id}`;
    const stores = [];
    const store = options => {
        const value = createTradingStateStorage({ databaseUrl, ...options });
        stores.push(value);
        return value;
    };
    t.after(async () => {
        await Promise.allSettled(stores.map(value => value.close()));
        await pool.query('DELETE FROM neto_trading_state WHERE state_key=$1', [hash(key)]);
        await pool.end();
    });
    return { id, key, pool, store, state: () => ({ ...empty(), accountId: id, version: 1 }) };
}
pgTest(
    'PostgreSQL journal restores settings, financial counters and pending contract after losing all process memory',
    async t => {
        const f = await fixture(t),
            first = f.store();
        await first.load(f.key);
        first.setItem(
            f.key,
            JSON.stringify({
                ...f.state(),
                pnl: -123,
                losses: 2,
                pending: { nonce: 'retained', contractId: 789 },
                settings: { ...f.state().settings, multiplier: 3, duration: 5 },
            })
        );
        await first.flush(f.key);
        await first.close();
        const second = f.store();
        await second.load(f.key);
        const restored = JSON.parse(second.getItem(f.key));
        assert.equal(restored.pending.contractId, 789);
        assert.equal(restored.pnl, -123);
        assert.equal(restored.settings.duration, 5);
        assert.equal(restored.settings.multiplier, 3);
        assert.equal(
            (
                await f.pool.query('SELECT state_key FROM neto_trading_state WHERE state_key=$1', [hash(f.key)])
            ).rows[0].state_key.includes(f.id),
            false
        );
    }
);
pgTest('legacy journal migration is insert-only and never replaces existing database history', async t => {
    const f = await fixture(t);
    const legacy = JSON.stringify({ ...f.state(), pending: { nonce: 'old-file', contractId: 123 } });
    const first = f.store({ legacyStorage: { getItem: () => legacy } });
    await first.load(f.key);
    assert.equal(JSON.parse(first.getItem(f.key)).pending.contractId, 123);
    first.setItem(f.key, JSON.stringify({ ...f.state(), pnl: 67 }));
    await first.flush(f.key);
    const second = f.store({
        legacyStorage: {
            getItem: () => {
                throw new Error('Stale file must not be consulted');
            },
        },
    });
    await second.load(f.key);
    assert.equal(JSON.parse(second.getItem(f.key)).pnl, 67);
});
pgTest('stale database writers cannot overwrite a newer account snapshot', async t => {
    const f = await fixture(t),
        first = f.store(),
        second = f.store();
    await Promise.all([first.load(f.key), second.load(f.key)]);
    first.setItem(f.key, JSON.stringify({ ...f.state(), pending: { nonce: 'first-order' } }));
    await first.flush(f.key);
    second.setItem(f.key, JSON.stringify({ ...f.state(), pending: { nonce: 'other-order' } }));
    await assert.rejects(second.flush(f.key), error => error.status === 409);
    assert.throws(() => second.setItem(f.key, JSON.stringify(f.state())), /another server/);
    const result = (await f.pool.query('SELECT data FROM neto_trading_state WHERE state_key=$1', [hash(f.key)]))
        .rows[0];
    assert.equal(result.data.pending.nonce, 'first-order');
});
pgTest('a corrupt/misbound database row is refused instead of restoring a different account', async t => {
    const f = await fixture(t),
        first = f.store();
    await first.load(f.key);
    first.setItem(f.key, JSON.stringify(f.state()));
    await first.flush(f.key);
    await f.pool.query('UPDATE neto_trading_state SET data=$2 WHERE state_key=$1', [
        hash(f.key),
        { version: 1, accountId: 'OTHER' },
    ]);
    const second = f.store();
    await assert.rejects(second.load(f.key), error => error.status === 503);
    assert.throws(() => second.getItem(f.key));
});
function broker(contract, onBuy) {
    return {
        connection: new EventTarget(),
        onMessage: () => ({ subscribe: () => ({ unsubscribe() {} }) }),
        disconnect() {},
        async send(body) {
            if (body.proposal) return { proposal: { ask_price: 0.35, payout: 0.67 } };
            if (body.balance) return { balance: { balance: 1000, currency: 'USD' } };
            if (body.buy) {
                await onBuy(body);
                return { buy: { contract_id: contract.contract_id, buy_price: 0.35, payout: 0.67 } };
            }
            if (body.proposal_open_contract) return { proposal_open_contract: contract };
            throw new Error('Unexpected broker request');
        },
    };
}
pgTest(
    'a purchase sees its committed intent first; an uncertain response survives restart and is reconciled once without another buy',
    async t => {
        const f = await fixture(t),
            storage = f.store();
        await storage.load(f.key);
        const account = { account_id: f.id, account_type: 'demo', status: 'active', currency: 'USD' };
        const contract = {
            contract_id: 9876,
            underlying: 'R_100',
            contract_type: 'DIGITUNDER',
            barrier: '7',
            currency: 'USD',
            buy_price: 0.35,
            payout: 0.67,
            tick_count: f.state().settings.duration,
            is_sold: 1,
            profit: 0.32,
        };
        let buys = 0;
        const api = broker(contract, async () => {
            buys++;
            const row = (await f.pool.query('SELECT data FROM neto_trading_state WHERE state_key=$1', [hash(f.key)]))
                .rows[0];
            assert.ok(row.data.pending.nonce, 'intent must be durable before the provider sees a buy');
            assert.equal(row.data.pending.contractId, undefined);
            throw new Error('Provider accepted but its acknowledgement was lost');
        });
        const first = new DigitStrategyEngine({ storage, account: () => account });
        first.selectAccount(account);
        // Exercise the real purchase path, independently of market-selection tests.
        first.api = api;
        first.state = { ...first.getSnapshot(), active: true, wantsRun: true };
        first.current = () => true;
        await first.execute({ symbol: 'R_100', direction: 'DIGITUNDER', barrier: '7', epoch: 1000 });
        await storage.flush(f.key);
        assert.equal(buys, 1);
        assert.equal(first.getSnapshot().phase, 'Reconciliation required');
        const restoredStorage = f.store();
        await restoredStorage.load(f.key);
        let connections = 0;
        const restored = new DigitStrategyEngine({
            storage: restoredStorage,
            account: () => account,
            createApi: async () => {
                connections++;
                return broker(contract, () => {
                    buys++;
                });
            },
        });
        restored.selectAccount(account);
        assert.equal(restored.getSnapshot().active, false);
        await assert.rejects(restored.start(restored.getSnapshot().settings), /unconfirmed/);
        assert.equal(connections, 0);
        await restored.start(restored.getSnapshot().settings, contract.contract_id);
        await restoredStorage.flush(f.key);
        assert.equal(buys, 1);
        assert.equal(restored.getSnapshot().pnl, 32);
        assert.equal(restored.getSnapshot().pending, undefined);
        assert.equal(restored.getSnapshot().active, false);
        const thirdStorage = f.store();
        await thirdStorage.load(f.key);
        const third = new DigitStrategyEngine({ storage: thirdStorage, account: () => account });
        third.selectAccount(account);
        assert.equal(third.getSnapshot().pnl, 32);
        assert.equal(third.getSnapshot().wins, 1);
        assert.equal(third.getSnapshot().pending, undefined);
    }
);

pgTest('a failed settlement commit retains the prior contract and restores its result exactly once', async t => {
    const f = await fixture(t);
    let failWrites = false,
        buys = 0;
    const storage = f.store({
        pool: {
            query: (sql, values) => {
                if (failWrites && sql.startsWith('UPDATE'))
                    return Promise.reject(new Error('Simulated database outage'));
                return f.pool.query(sql, values);
            },
        },
    });
    await storage.load(f.key);
    const account = { account_id: f.id, account_type: 'demo', status: 'active', currency: 'USD' };
    const contract = {
        contract_id: 7654,
        underlying: 'R_100',
        contract_type: 'DIGITUNDER',
        barrier: '7',
        currency: 'USD',
        buy_price: 0.35,
        payout: 0.67,
        tick_count: f.state().settings.duration,
        is_sold: 0,
    };
    const first = new DigitStrategyEngine({ storage, account: () => account });
    first.selectAccount(account);
    first.api = broker(contract, () => {
        buys++;
    });
    first.state = { ...first.getSnapshot(), active: true, wantsRun: true };
    first.current = () => true;
    await first.execute({ symbol: 'R_100', direction: 'DIGITUNDER', barrier: '7', epoch: 1000 });
    await storage.flush(f.key);
    failWrites = true;
    first.contract({ ...contract, is_sold: 1, profit: 0.32 });
    await assert.rejects(storage.flush(f.key), error => error.status === 503);
    first.cleanup();
    const restoredStorage = f.store();
    await restoredStorage.load(f.key);
    assert.equal(JSON.parse(restoredStorage.getItem(f.key)).pending.contractId, contract.contract_id);
    const restored = new DigitStrategyEngine({
        storage: restoredStorage,
        account: () => account,
        createApi: async () =>
            broker({ ...contract, is_sold: 1, profit: 0.32 }, () => {
                buys++;
            }),
    });
    restored.selectAccount(account);
    await restored.start(restored.getSnapshot().settings, contract.contract_id);
    await restoredStorage.flush(f.key);
    assert.equal(buys, 1);
    assert.equal(restored.getSnapshot().pnl, 32);
    assert.equal(restored.getSnapshot().wins, 1);
    restored.contract({ ...contract, is_sold: 1, profit: 0.32 });
    assert.equal(restored.getSnapshot().pnl, 32);
});

pgTest(
    'the production service selects DATABASE_URL and restores a stopped account before checking Builder purchases',
    async t => {
        const f = await fixture(t),
            first = f.store();
        await first.load(f.key);
        first.setItem(
            f.key,
            JSON.stringify({
                ...f.state(),
                pending: { nonce: 'restart-intent', contractId: 333 },
                active: true,
                owner: 'previous-process',
                liveUntil: Date.now() + 15000,
            })
        );
        await first.flush(f.key);
        const previousUrl = process.env.DATABASE_URL;
        process.env.DATABASE_URL = databaseUrl;
        let service,
            server,
            connections = 0;
        try {
            const account = { account_id: f.id, account_type: 'demo', status: 'active', currency: 'USD' };
            service = require('./analysis.cjs').createAnalysisService(
                {
                    publicOrigin: 'http://localhost',
                    authorizeAccount: async (_, id) => {
                        if (id !== f.id) throw Object.assign(new Error('Account denied'), { status: 403 });
                        return account;
                    },
                },
                {
                    brokerFactory: async () => {
                        connections++;
                        throw new Error('Must not reconnect automatically');
                    },
                }
            );
            server = require('node:http').createServer(service.handle);
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analysis?account_id=${f.id}`);
            assert.equal(response.status, 200);
            const state = await response.json();
            assert.equal(service.storageMode, 'postgres');
            assert.equal(state.active, false);
            assert.equal(state.pending.contractId, 333);
            assert.equal(state.owner, 'previous-process');
            assert.equal(connections, 0);
            await service.prepareBuilder(f.id);
            assert.throws(() => service.beforeBuilder(f.id, { buy: 1 }), /Stop and settle/);
        } finally {
            if (service) await service.close();
            if (server) {
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
            if (previousUrl === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = previousUrl;
        }
    }
);
