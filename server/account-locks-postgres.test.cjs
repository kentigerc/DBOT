const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createAccountLocks } = require('./account-locks.cjs');
const databaseUrl = process.env.NETO_TEST_DATABASE_URL;
const pgTest = (name, fn) => test(name, { skip: !databaseUrl }, fn);
async function fixture(t) {
    const pool = new (require('pg').Pool)({ connectionString: databaseUrl });
    const account = 'LOCK-' + randomUUID(),
        hash = createHash('sha256').update(account).digest('hex');
    const stores = [];
    const create = options => {
        const locks = createAccountLocks({ databaseUrl, schedule: () => ({ unref() {} }), cancel() {}, ...options });
        stores.push(locks);
        return locks;
    };
    t.after(async () => {
        await Promise.allSettled(stores.map(x => x.close()));
        await pool.query('DELETE FROM neto_account_settlements WHERE account_key=$1', [hash]);
        await pool.query('DELETE FROM neto_account_locks WHERE account_key=$1', [hash]);
        await pool.end();
    });
    const expire = () =>
        pool.query("UPDATE neto_account_locks SET lease_until=NOW()-INTERVAL '1 second' WHERE account_key=$1", [hash]);
    return { pool, account, hash, create, expire };
}
pgTest('only one server can acquire an account; unrelated accounts remain independent', async t => {
    const f = await fixture(t),
        a = f.create(),
        b = f.create();
    const results = await Promise.allSettled([a.claim(f.account), b.claim(f.account)]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.find(x => x.status === 'rejected').reason.status, 409);
    const other = await b.claim(f.account + '-other');
    await b.release(other);
    await f.pool.query('DELETE FROM neto_account_locks WHERE account_key=$1', [
        createHash('sha256')
            .update(f.account + '-other')
            .digest('hex'),
    ]);
});
pgTest('expired idle leases can transfer and stale handles cannot buy or release the replacement', async t => {
    const f = await fixture(t),
        a = f.create(),
        b = f.create();
    const first = await a.claim(f.account);
    await f.expire();
    const second = await b.claim(f.account);
    await assert.rejects(a.protect(first, 'stale-order'), e => e.status === 409);
    await a.release(first);
    await b.protect(second, 'current-order');
    await b.cancel(second, 'current-order');
});
pgTest('a pending purchase blocks takeover after expiry until a verified settlement arrives', async t => {
    const f = await fixture(t),
        a = f.create(),
        b = f.create();
    const handle = await a.claim(f.account, { mode: 'builder' });
    await a.protect(handle, 'pending-order');
    await f.expire();
    await assert.rejects(b.claim(f.account), e => e.status === 409);
    await a.acknowledge(handle, 'pending-order', 12345);
    await a.cancel(handle, 'pending-order');
    await assert.rejects(b.claim(f.account), e => e.status === 409);
    await b.settled(f.account, 12345);
    await b.claim(f.account);
});
pgTest(
    'only the matching server journal can claim an expired analysis recovery; Builder intents are excluded',
    async t => {
        const f = await fixture(t),
            a = f.create(),
            b = f.create();
        const first = await a.claim(f.account);
        await a.protect(first, 'journal-nonce');
        await f.expire();
        await assert.rejects(b.claim(f.account, { reconcile: ['wrong'] }), e => e.status === 409);
        const recovery = await b.claim(f.account, { reconcile: ['journal-nonce'] });
        await b.acknowledge(recovery, 'journal-nonce', 444, true);
        await b.settled(f.account, 444);
        await b.protect(recovery, 'next-order');
        await b.cancel(recovery, 'next-order');
    }
);
pgTest('out-of-order settlement receipts on another replica cannot leave an acknowledged purchase pending', async t => {
    const f = await fixture(t),
        a = f.create(),
        b = f.create();
    const handle = await a.claim(f.account, { mode: 'builder' });
    await a.protect(handle, 'late-ack');
    await b.settled(f.account, 555);
    await a.acknowledge(handle, 'late-ack', 555);
    await f.expire();
    await b.claim(f.account);
});
pgTest('a remote STOP request reaches the current server through its renewal check', async t => {
    const f = await fixture(t),
        a = f.create(),
        b = f.create();
    const handle = await a.claim(f.account);
    let stopped = 0;
    a.hold(handle, { onStop: () => stopped++ });
    await b.requestStop(f.account);
    await a.heartbeat();
    assert.equal(stopped, 1);
    await assert.rejects(a.protect(handle, 'after-stop'), e => e.status === 409);
});
pgTest('lease renewal failure stops its holder and blocks subsequent purchases', async t => {
    const f = await fixture(t);
    let fail = false;
    const a = f.create({
        pool: {
            query: (sql, params) =>
                fail ? Promise.reject(new Error('private storage URL')) : f.pool.query(sql, params),
        },
    });
    const handle = await a.claim(f.account);
    let lost = 0;
    a.hold(handle, { onLost: () => lost++ });
    fail = true;
    await a.heartbeat();
    assert.equal(lost, 1);
    await assert.rejects(a.protect(handle, 'blocked'), e => e.status === 503 && !e.message.includes('private'));
});

pgTest('even the current holder cannot send a second purchase while its first outcome is unresolved', async t => {
    const f = await fixture(t),
        owner = f.create();
    const handle = await owner.claim(f.account, { mode: 'builder' });
    await owner.protect(handle, 'first');
    await assert.rejects(owner.protect(handle, 'second'), error => error.status === 409);
    await owner.acknowledge(handle, 'first', 98765);
    await assert.rejects(owner.protect(handle, 'third'), error => error.status === 409);
    await owner.settled(f.account, 98765);
    await owner.protect(handle, 'after-settlement');
    await owner.cancel(handle, 'after-settlement');
});

pgTest('reacquiring an idle account on the same server rotates the fencing token', async t => {
    const f = await fixture(t),
        server = f.create();
    const old = await server.claim(f.account, { mode: 'builder' });
    await server.release(old);
    const current = await server.claim(f.account, { mode: 'builder' });
    assert.notEqual(old.token, current.token);
    await assert.rejects(server.protect(old, 'old-request'), error => error.status === 409);
    await server.protect(current, 'current-request');
    await server.cancel(current, 'current-request');
});
