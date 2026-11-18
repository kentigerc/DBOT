const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTradingStateStorage, MAX_STATE_BYTES } = require('./trading-state.cjs');
const key = 'neto.digit-strategy.v1.TEST';
const value = JSON.stringify({ version: 1, accountId: 'TEST', pending: { nonce: 'order' } });

test('unread or unavailable database state never becomes an empty file-backed account', async () => {
    let legacyReads = 0;
    const store = createTradingStateStorage({
        pool: {
            query: async () => {
                throw new Error('sensitive driver details');
            },
        },
        legacyStorage: {
            getItem: () => {
                legacyReads++;
                return value;
            },
        },
    });
    assert.throws(() => store.getItem(key), /storage is unavailable/);
    await assert.rejects(store.load(key), error => error.status === 503 && !error.message.includes('sensitive'));
    assert.equal(legacyReads, 0);
    assert.throws(() => store.getItem(key));
    await store.close();
});
test('invalid or oversized snapshots fail before they can overwrite a valid journal', async () => {
    let writes = 0;
    const store = createTradingStateStorage({
        pool: {
            query: async sql => {
                if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) writes++;
                return { rows: [] };
            },
        },
    });
    await store.load(key);
    for (const invalid of [
        'null',
        '[]',
        '{}',
        JSON.stringify({ version: 1, accountId: 'OTHER' }),
        'x'.repeat(MAX_STATE_BYTES + 1),
    ])
        assert.throws(() => store.setItem(key, invalid));
    assert.equal(writes, 0);
    assert.equal(store.getItem(key), null);
    await store.close();
});
test('a failed commit rejects its checkpoint and fences subsequent writes without unhandled rejections', async () => {
    const store = createTradingStateStorage({
        pool: {
            query: async sql => {
                if (sql.startsWith('INSERT')) throw new Error('postgresql://private-credential');
                return { rows: [] };
            },
        },
    });
    await store.load(key);
    store.setItem(key, value);
    await assert.rejects(store.flush(key), error => error.status === 503 && !error.message.includes('credential'));
    assert.throws(() => store.setItem(key, value), /No new purchases/);
    assert.throws(() => store.getItem(key), /No new purchases/);
    await store.close();
});

test('slow storage coalesces heartbeats while each checkpoint waits for its own committed revision', async () => {
    const writes = [];
    const store = createTradingStateStorage({
        pool: {
            query: (sql, values) => {
                if (sql.startsWith('INSERT') || sql.startsWith('UPDATE'))
                    return new Promise(resolve => writes.push({ values, resolve }));
                return Promise.resolve({ rows: [] });
            },
        },
    });
    await store.load(key);
    store.setItem(key, JSON.stringify({ version: 1, accountId: 'TEST', pnl: 1 }));
    const firstCheckpoint = store.flush(key);
    store.setItem(key, JSON.stringify({ version: 1, accountId: 'TEST', pnl: 2 }));
    store.setItem(key, JSON.stringify({ version: 1, accountId: 'TEST', pnl: 3 }));
    const lastCheckpoint = store.flush(key);
    assert.equal(writes.length, 1);
    writes[0].resolve({ rows: [{ revision: '1' }] });
    await firstCheckpoint;
    assert.equal(writes.length, 2);
    assert.equal(JSON.parse(writes[1].values[1]).pnl, 3);
    let committed = false;
    lastCheckpoint.then(() => {
        committed = true;
    });
    await Promise.resolve();
    assert.equal(committed, false);
    writes[1].resolve({ rows: [{ revision: '2' }] });
    await lastCheckpoint;
    assert.equal(committed, true);
    await store.close();
    await store.close();
});

test('paired XML and analysis journals use separate validated namespaces', async () => {
    const commits = [];
    const store = createTradingStateStorage({
        pool: {
            query: async (sql, values) => {
                if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
                    commits.push(values);
                    return { rows: [{ revision: '1' }] };
                }
                return { rows: [] };
            },
        },
    });
    const analysis = 'neto.higher-lower.v1.TEST',
        xml = 'neto.higher-lower-xml.v1.TEST';
    await store.load(analysis);
    await store.load(xml);
    store.setItem(analysis, JSON.stringify({ version: 1, accountId: 'TEST', pnl: 1 }));
    store.setItem(xml, JSON.stringify({ version: 1, accountId: 'TEST', pnl: 2 }));
    await store.flush(analysis);
    await store.flush(xml);
    assert.equal(JSON.parse(store.getItem(analysis)).pnl, 1);
    assert.equal(JSON.parse(store.getItem(xml)).pnl, 2);
    assert.notEqual(commits[0][0], commits[1][0]);
    assert.throws(() => store.setItem(xml, JSON.stringify({ version: 1, accountId: 'OTHER' })));
    await store.close();
});
