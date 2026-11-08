const test = require('node:test');
const assert = require('node:assert/strict');
const { createDemoPause } = require('./demo-pause.cjs');
const { createAccountLocks } = require('./account-locks.cjs');

const real = { account_id: 'REAL1', account_type: 'real', currency: 'USD', status: 'active' };
const demo = { account_id: 'DEMO1', account_type: 'demo', currency: 'USD', status: 'active' };
const spec = { triggerContractId: 100, symbol: 'R_100', direction: 'DIGITODD', duration: 1, stake: 0.35 };
function fixture(t, options = {}) {
    const records = new Map(),
        orders = [],
        reports = [],
        urls = [],
        contracts = new Map();
    let nextId = 1000,
        clock = 1000000,
        dropReceipt = !!options.dropReceipt,
        dropWatch = !!options.dropWatch;
    const storage = {
        getItem: key => records.get(key) || null,
        setItem: (key, value) => records.set(key, value),
        flush: async key => {
            if (options.failIntent && JSON.parse(records.get(key)).pending) throw new Error('Database failure');
        },
    };
    const locks = createAccountLocks({ databaseUrl: '', now: () => clock });
    t.after(() => locks.close());
    const auth = {
        verifySession: async () => {},
        demoAccount: async () => (options.noDemo ? { ...real } : demo),
        connectionUrl: async (_req, id) => {
            assert.equal(id, demo.account_id);
            return `demo://${id}`;
        },
    };
    const runner = createDemoPause({
        auth,
        storage,
        locks,
        now: () => clock,
        wait: async ms => {
            clock += ms;
        },
        busy: id => options.busyDemo && id === demo.account_id,
        onTrade: (account, tool, packet) => reports.push({ account, tool, packet }),
        brokerFactory: async url => {
            urls.push(url);
            return {
                disconnect() {},
                async send(body) {
                    if (body.balance) return { balance: { currency: 'USD', balance: options.lowBalance ? 0.2 : 1000 } };
                    if (body.proposal) return { proposal: { ask_price: body.amount, payout: 0.67 } };
                    if (body.buy) {
                        const intent = [...records.values()].map(JSON.parse).find(s => s.pending)?.pending;
                        assert.ok(intent?.nonce, 'A durable intent must exist before a demo buy');
                        assert.equal(body.parameters.currency, 'USD');
                        assert.equal(body.price, 0.35, 'Demo trades use the starting stake, not the high real stake');
                        orders.push(body);
                        const id = ++nextId;
                        contracts.set(id, {
                            contract_id: id,
                            is_sold: 1,
                            profit: options.profits?.[orders.length - 1] ?? -0.35,
                        });
                        await options.onBuy?.();
                        if (dropReceipt) {
                            dropReceipt = false;
                            throw new Error('Connection closed after send');
                        }
                        return { buy: { contract_id: id, buy_price: body.price } };
                    }
                    if (body.proposal_open_contract) {
                        if (dropWatch) {
                            dropWatch = false;
                            throw new Error('Connection closed during settlement');
                        }
                        return { proposal_open_contract: contracts.get(body.contract_id) };
                    }
                    throw new Error('Unexpected request');
                },
            };
        },
    });
    return { runner, orders, reports, urls, records, storage, locks };
}
test('completes exactly two demo trades even when both lose, without touching a real account', async t => {
    const f = fixture(t);
    const held = { stake: 220, pnl: -123, streak: 4 };
    const result = await f.runner.run({}, real, spec, { sourceTool: 'even_odd' });
    assert.equal(result.completed, 2);
    assert.equal(result.status, 'done');
    assert.deepEqual(
        result.trades.map(t => t.profit),
        [-35, -35]
    );
    assert.deepEqual(held, { stake: 220, pnl: -123, streak: 4 });
    assert.equal(f.orders.length, 2);
    assert.deepEqual(f.urls, ['demo://DEMO1']);
    assert.ok(f.reports.every(r => r.account.account_type === 'demo' && r.tool === 'even_odd'));
    const again = await f.runner.run({}, real, spec);
    assert.equal(again.completed, 2);
    assert.equal(f.orders.length, 2, 'An acknowledged pause is idempotent');
});
test('supports Over/Under recovery and uses the selected duration for both demo trades', async t => {
    const f = fixture(t, { profits: [0.32, -0.35] });
    await f.runner.run({}, real, { ...spec, direction: 'DIGITUNDER', barrier: '6', duration: 5 });
    assert.ok(
        f.orders.every(
            o =>
                o.parameters.duration === 5 &&
                o.parameters.contract_type === 'DIGITUNDER' &&
                o.parameters.barrier === '6'
        )
    );
});
test('stops after an already purchased demo contract settles and resumes only the remaining demo trade', async t => {
    const controller = new AbortController();
    const f = fixture(t, { onBuy: () => controller.abort() });
    await assert.rejects(f.runner.run({}, real, spec, { signal: controller.signal }), /stopped/);
    const first = await f.runner.status(real.account_id, spec.triggerContractId);
    assert.equal(first.completed, 1);
    assert.equal(first.status, 'stopped');
    assert.equal(f.orders.length, 1);
    await f.runner.run({}, real, spec);
    assert.equal(f.orders.length, 2);
});
test('never retries an unconfirmed demo purchase', async t => {
    const f = fixture(t, { dropReceipt: true });
    await assert.rejects(f.runner.run({}, real, spec), /Real recovery remains paused/);
    await assert.rejects(f.runner.run({}, real, spec), /unconfirmed/);
    assert.equal(f.orders.length, 1);
    assert.equal((await f.runner.status(real.account_id, spec.triggerContractId)).completed, 0);
});
test('reconciles a confirmed demo contract after a connection interruption instead of buying it again', async t => {
    const f = fixture(t, { dropWatch: true });
    await assert.rejects(f.runner.run({}, real, spec), /Real recovery remains paused/);
    const pending = await f.runner.status(real.account_id, spec.triggerContractId);
    assert.equal(pending.pendingContractId, 1001);
    const result = await f.runner.run({}, real, spec);
    assert.equal(result.completed, 2);
    assert.equal(f.orders.length, 2);
});
for (const option of ['noDemo', 'busyDemo', 'lowBalance', 'failIntent']) {
    test(`blocks real resumption and sends no demo purchase when ${option}`, async t => {
        const f = fixture(t, { [option]: true });
        await assert.rejects(f.runner.run({}, real, spec));
        assert.equal(f.orders.length, 0);
    });
}
test('rejects invalid identifiers, directions, precision and account overrides before any broker is opened', async t => {
    const f = fixture(t);
    for (const change of [
        { triggerContractId: -1 },
        { symbol: '../private' },
        { direction: 'CALL' },
        { duration: 6 },
        { stake: 0.001 },
        { demoAccountId: 'someone-else' },
    ])
        await assert.rejects(f.runner.run({}, real, { ...spec, ...change }));
    await assert.rejects(f.runner.run({}, demo, spec));
    assert.equal(f.urls.length, 0);
});

test('reserves a shared demo account across real wallets and can stop it from another device', async t => {
    let releaseBuy;
    const buyGate = new Promise(resolve => {
        releaseBuy = resolve;
    });
    const f = fixture(t, { onBuy: () => buyGate });
    const first = f.runner.run({}, real, spec);
    while (!f.orders.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.runner.busy(real.account_id), true);
    assert.equal(f.runner.busy(demo.account_id), true);
    await assert.rejects(f.runner.run({}, { ...real, account_id: 'REAL2' }, spec), /another recovery pause/);
    f.runner.stop(demo.account_id);
    releaseBuy();
    await assert.rejects(first, /stopped/);
    assert.equal(f.orders.length, 1);
    assert.equal(f.runner.busy(real.account_id), false);
    assert.equal(f.runner.busy(demo.account_id), false);
});

test('refreshes the durable journal revision after acquiring the real account lease', async t => {
    const f = fixture(t);
    let stale = true;
    f.storage.reload = async () => {
        const holder = await f.locks.current(real.account_id);
        assert.equal(holder.active, true);
        stale = false;
    };
    const flush = f.storage.flush;
    f.storage.flush = async key => {
        assert.equal(stale, false, 'A previously cached status must not become a stale state writer');
        await flush(key);
    };
    assert.equal((await f.runner.run({}, real, spec)).completed, 2);
});
