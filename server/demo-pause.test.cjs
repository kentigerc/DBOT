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
                            profit: options.profits?.[orders.length - 1] ?? (orders.length === 1 ? -0.35 : 0.32),
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
                        return {
                            proposal_open_contract: {
                                ...contracts.get(body.contract_id),
                                ...(options.open ? { is_sold: 0 } : {}),
                            },
                        };
                    }
                    throw new Error('Unexpected request');
                },
            };
        },
    });
    return { runner, orders, reports, urls, records, storage, locks };
}
test('stays on demo through losses and voids until its first win without touching a real account', async t => {
    const f = fixture(t, { profits: [-0.35, -0.35, 0, -0.35, 0.32] });
    const held = { stake: 220, pnl: -123, streak: 4 };
    const result = await f.runner.run({}, real, spec, { sourceTool: 'even_odd' });
    assert.equal(result.completed, 5);
    assert.equal(result.status, 'done');
    assert.equal(result.wins, 1);
    assert.deepEqual(
        result.trades.map(t => t.profit),
        [-35, -35, 0, -35, 32]
    );
    assert.deepEqual(held, { stake: 220, pnl: -123, streak: 4 });
    assert.equal(f.orders.length, 5);
    assert.deepEqual(f.urls, ['demo://DEMO1']);
    assert.ok(f.reports.every(r => r.account.account_type === 'demo' && r.tool === 'even_odd'));
    const again = await f.runner.run({}, real, spec);
    assert.equal(again.completed, 5);
    assert.equal(f.orders.length, 5, 'An acknowledged pause is idempotent');
});
test('supports Over/Under recovery and uses the selected duration for each demo trade', async t => {
    const f = fixture(t, { profits: [-0.35, 0.32] });
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
test('returns immediately after a first-trade demo win', async t => {
    const f = fixture(t, { profits: [0.32, -0.35] });
    const result = await f.runner.run({}, real, spec);
    assert.equal(result.completed, 1);
    assert.equal(result.wins, 1);
    assert.equal(f.orders.length, 1);
});
test('Builder demo pauses preserve uploaded bot digit contracts and tick duration', async t => {
    const f = fixture(t);
    const result = await f.runner.run({}, real, {
        triggerContractId: 100,
        stake: 0.35,
        contract: { symbol: '1HZ90V', contract_type: 'DIGITDIFF', barrier: '4', duration: 10, duration_unit: 't' },
    });
    assert.equal(result.wins, 1);
    assert.equal(result.completed, 2);
    assert.ok(
        f.orders.every(
            order =>
                order.parameters.contract_type === 'DIGITDIFF' &&
                order.parameters.barrier === '4' &&
                order.parameters.duration === 10 &&
                order.parameters.symbol === '1HZ90V'
        )
    );
});
test('Builder demo pauses support finite Rise/Fall contracts and retain their duration unit', async t => {
    const f = fixture(t, { profits: [0.32] });
    await f.runner.run({}, real, {
        triggerContractId: 100,
        stake: 0.35,
        contract: { symbol: 'frxEURUSD', contract_type: 'CALL', duration: 5, duration_unit: 'm' },
    });
    assert.equal(f.orders[0].parameters.duration_unit, 'm');
    assert.equal(f.orders[0].parameters.contract_type, 'CALL');
});

test('STOP releases a long-expiry Builder demo worker and retains its confirmed order for reconciliation', async t => {
    const controller = new AbortController();
    const options = { open: true, onBuy: () => controller.abort() };
    const f = fixture(t, options);
    const plan = {
        triggerContractId: 100,
        stake: 0.35,
        contract: { symbol: 'R_100', contract_type: 'CALL', duration: 1, duration_unit: 'd' },
    };
    await assert.rejects(f.runner.run({}, real, plan, { signal: controller.signal }), /stopped/);
    assert.equal(f.orders.length, 1);
    assert.equal((await f.runner.status(real.account_id, 100)).pendingContractId, 1001);
    options.open = false;
    assert.equal((await f.runner.run({}, real, plan)).wins, 1);
    assert.equal(f.orders.length, 2, 'The confirmed demo order is reconciled instead of duplicated');
});
test('rejects unsupported or tampered Builder contract parameters before any demo purchase', async t => {
    const f = fixture(t);
    for (const contract of [
        { symbol: '../private', contract_type: 'CALL', duration: 1, duration_unit: 't' },
        { symbol: 'R_100', contract_type: 'ACCU', duration: 1, duration_unit: 't' },
        { symbol: 'R_100', contract_type: 'CALL', duration: 1, duration_unit: 'constructor' },
        { symbol: 'R_100', contract_type: 'CALL', duration: 1, duration_unit: 't', account_id: 'OTHER' },
        { symbol: 'R_100', contract_type: 'CALL' },
        { symbol: 'R_100', contract_type: 'CALL', duration: -1, duration_unit: 't' },
    ])
        await assert.rejects(f.runner.run({}, real, { triggerContractId: 100, stake: 0.35, contract }));
    assert.equal(f.orders.length, 0);
});

test('keeps waiting for a win over a long demo loss streak with bounded settlement history', async t => {
    const f = fixture(t, { profits: [...Array(105).fill(-0.35), 0.32] });
    const result = await f.runner.run({}, real, spec);
    assert.equal(result.completed, 106);
    assert.equal(result.wins, 1);
    assert.equal(result.trades.length, 100);
    assert.equal(f.orders.length, 106);
});

test('an older two-loss completion does not authorize real resumption without a demo win', async t => {
    const controller = new AbortController();
    let count = 0;
    const f = fixture(t, {
        profits: [-0.35, -0.35, 0.32],
        onBuy: () => {
            if (++count === 2) controller.abort();
        },
    });
    await assert.rejects(f.runner.run({}, real, spec, { signal: controller.signal }), /stopped/);
    const [key, value] = [...f.records][0];
    const legacy = JSON.parse(value);
    delete legacy.completionRule;
    delete legacy.wins;
    legacy.status = 'done';
    legacy.completedTriggers = [spec.triggerContractId];
    f.records.set(key, JSON.stringify(legacy));
    const result = await f.runner.run({}, real, spec);
    assert.equal(result.completed, 3);
    assert.equal(result.wins, 1);
    assert.equal(f.orders.length, 3);
});

test('settles a legacy pending demo order even if an earlier demo trade already won', async t => {
    const f = fixture(t, { dropWatch: true });
    await assert.rejects(f.runner.run({}, real, spec), /Real recovery remains paused/);
    const [key, value] = [...f.records][0];
    const legacy = JSON.parse(value);
    delete legacy.completionRule;
    delete legacy.wins;
    legacy.completed = 1;
    legacy.trades = [{ contractId: 999, profit: 32, stake: 35, at: 999999 }];
    f.records.set(key, JSON.stringify(legacy));
    const result = await f.runner.run({}, real, spec);
    assert.equal(result.completed, 2);
    assert.equal(result.wins, 1);
    assert.equal(result.pendingContractId, undefined);
    assert.equal(f.orders.length, 1, 'Reconcile the pending legacy order without buying another');
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
