const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRevocations } = require('./revocations.cjs');
test('logout revocation survives process reconstruction, stores only a hash, and expires at the deadline', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neto-revoked-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let now = 1000;
    const options = { databaseUrl: '', directory, now: () => now };
    await createRevocations(options).revoke('test-only-session-id', 3000);
    const journal = await fs.readFile(path.join(directory, 'revoked.json'), 'utf8');
    assert.ok(!journal.includes('test-only-session-id'));
    assert.equal(await createRevocations(options).isRevoked('test-only-session-id'), true);
    assert.equal(await createRevocations(options).isRevoked('different-session'), false);
    now = 3001;
    assert.equal(await createRevocations(options).isRevoked('test-only-session-id'), false);
    await fs.writeFile(path.join(directory, 'revoked.json'), 'corrupted');
    await assert.rejects(
        () => createRevocations(options).isRevoked('test-only-session-id'),
        /verification is temporarily unavailable/
    );
});
