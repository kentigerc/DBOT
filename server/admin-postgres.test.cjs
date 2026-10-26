const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAnalyticsStore } = require('./analytics-store.cjs');
const databaseUrl = process.env.NETO_TEST_DATABASE_URL;
test(
    'PostgreSQL stores idempotent events across reconnects and prunes expired history',
    { skip: !databaseUrl },
    async () => {
        const url = new URL(databaseUrl);
        assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
        assert.equal(url.pathname, '/neto_analytics');
        const id = `integration-${Date.now()}`;
        let store = createAnalyticsStore({ databaseUrl });
        try {
            const event = { id, kind: 'visit', at: Date.now(), visitor: 'test-hash' };
            await store.put(event);
            await store.put({ ...event, visitor: 'duplicate-must-not-replace' });
            await store.close();
            store = createAnalyticsStore({ databaseUrl });
            const rows = await store.list(event.at - 1, event.at + 1);
            assert.deepEqual(
                rows.filter(row => row.id === id),
                [event]
            );
            await store.put({ ...event, id: id + '-old', at: Date.parse('2020-01-01') });
            await store.prune();
            assert.equal((await store.list(Date.parse('2019-01-01'), Date.parse('2021-01-01'))).length, 0);
        } finally {
            await store.close();
        }
    }
);
