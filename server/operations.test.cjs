const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOperations } = require('./operations.cjs');
const good = () => ({
    journal: { mode: 'postgres', failedAccounts: 0 },
    protection: { mode: 'postgres', healthy: true },
    locks: { mode: 'postgres', active: 2, pending: 1, unresolved: 0 },
    active: 1,
});
test('operational probes are cached and do not report an ordinary open contract as an outage', async () => {
    let calls = 0,
        at = 100000;
    const ops = createOperations({
        origin: 'https://example.test',
        nodeVersion: '24.1.0',
        now: () => at,
        trading: async () => {
            calls++;
            return good();
        },
        analytics: async () => ({ mode: 'postgres', healthy: true }),
        log() {},
    });
    const [a, b] = await Promise.all([ops.get(), ops.get()]);
    assert.equal(calls, 1);
    assert.equal(a.status, 'ok');
    assert.equal(b.pendingPurchases, 1);
    at += 30001;
    await ops.get();
    assert.equal(calls, 2);
});
test('failed probes produce bounded, sanitized alerts and record recovery', async () => {
    let at = 1000,
        fail = true;
    const events = [];
    const ops = createOperations({
        origin: 'https://example.test',
        nodeVersion: '24.1.0',
        now: () => at,
        cacheMs: 0,
        trading: async () => {
            if (fail) throw new Error('postgresql://user:secret@private');
            return good();
        },
        analytics: async () => ({ mode: 'postgres', healthy: true }),
        log: e => events.push(e),
    });
    const bad = await ops.get();
    assert.equal(bad.status, 'error');
    assert.equal(JSON.stringify(bad).includes('secret'), false);
    await ops.get();
    assert.equal(events.length, 1);
    fail = false;
    at += 1;
    const fixed = await ops.get();
    assert.ok(fixed.alerts.some(x => x.code === 'trading_database' && x.status === 'ok'));
    assert.equal(JSON.stringify(events).includes('private'), false);
});
test('provider connection failures are visible without recording account identities or tokens', async () => {
    const ops = createOperations({
        origin: 'https://example.test',
        trading: async () => good(),
        analytics: async () => ({ mode: 'postgres', healthy: true }),
        log() {},
    });
    ops.record('trading_connection_lost');
    const state = await ops.get();
    assert.equal(state.connectionDrops, 1);
    assert.equal(state.checks.find(x => x.code === 'deriv_connections').status, 'warning');
});
