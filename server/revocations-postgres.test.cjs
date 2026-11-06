const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { createRevocations } = require('./revocations.cjs');
// Use an isolated test database, never the production DATABASE_URL.
const databaseUrl = process.env.NETO_TEST_DATABASE_URL;
test('PostgreSQL logout revocation is shared by independent processes/stores', { skip: !databaseUrl }, async t => {
    const first = createRevocations({ databaseUrl }),
        second = createRevocations({ databaseUrl });
    t.after(async () => {
        await first.close();
        await second.close();
    });
    const sid = randomUUID();
    assert.equal(await second.isRevoked(sid), false);
    await first.revoke(sid, Date.now() + 60000);
    assert.equal(await second.isRevoked(sid), true);
    const pool = new (require('pg').Pool)({ connectionString: databaseUrl });
    try {
        await pool.query('DELETE FROM neto_session_revocations WHERE sid_hash=$1', [
            createHash('sha256').update(sid).digest('hex'),
        ]);
    } finally {
        await pool.end();
    }
});
