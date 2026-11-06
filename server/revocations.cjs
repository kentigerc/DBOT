const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
function createRevocations({
    databaseUrl = process.env.DATABASE_URL,
    directory = process.env.NETO_AUTH_STATE_DIR || path.join(__dirname, '../.auth-state'),
    now = Date.now,
} = {}) {
    const hash = sid => createHash('sha256').update(sid).digest('hex');
    let pool, ready;
    if (databaseUrl) {
        const { Pool } = require('pg');
        pool = new Pool({
            connectionString: databaseUrl,
            max: 3,
            connectionTimeoutMillis: 5000,
            statement_timeout: 5000,
        });
    }
    const load = () => {
        try {
            const value = JSON.parse(fs.readFileSync(path.join(directory, 'revoked.json'), 'utf8'));
            if (
                !Array.isArray(value) ||
                value.some(row => !Array.isArray(row) || !/^[a-f0-9]{64}$/.test(row[0]) || !Number.isFinite(row[1]))
            )
                throw new Error('Invalid revocation journal');
            return new Map(value.filter(([, until]) => until > now()));
        } catch (error) {
            if (error.code === 'ENOENT') return new Map();
            throw new Error('Session revocation storage is unavailable.');
        }
    };
    const ensure = async () => {
        if (!ready)
            ready = pool
                .query(
                    'CREATE TABLE IF NOT EXISTS neto_session_revocations (sid_hash text PRIMARY KEY, expires_at timestamptz NOT NULL)'
                )
                .catch(() => {
                    ready = null;
                    throw new Error('Session revocation storage is unavailable.');
                });
        await ready;
    };
    return {
        async isRevoked(sid) {
            try {
                if (!pool) return load().has(hash(sid));
                await ensure();
                const result = await pool.query(
                    'SELECT 1 FROM neto_session_revocations WHERE sid_hash = $1 AND expires_at > $2',
                    [hash(sid), new Date(now())]
                );
                return result.rows.length > 0;
            } catch {
                throw Object.assign(new Error('Session verification is temporarily unavailable.'), { status: 503 });
            }
        },
        async revoke(sid, until) {
            try {
                if (pool) {
                    await ensure();
                    await pool.query(
                        'INSERT INTO neto_session_revocations (sid_hash, expires_at) VALUES ($1,$2) ON CONFLICT (sid_hash) DO UPDATE SET expires_at = GREATEST(neto_session_revocations.expires_at, EXCLUDED.expires_at)',
                        [hash(sid), new Date(until)]
                    );
                    await pool.query('DELETE FROM neto_session_revocations WHERE expires_at <= $1', [new Date(now())]);
                } else {
                    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
                    const records = load();
                    records.set(hash(sid), until);
                    const temporary = path.join(directory, 'revoked.tmp');
                    const fd = fs.openSync(temporary, 'w', 0o600);
                    try {
                        fs.writeFileSync(fd, JSON.stringify([...records]));
                        fs.fsyncSync(fd);
                    } finally {
                        fs.closeSync(fd);
                    }
                    fs.renameSync(temporary, path.join(directory, 'revoked.json'));
                    const parent = fs.openSync(directory, 'r');
                    try {
                        fs.fsyncSync(parent);
                    } finally {
                        fs.closeSync(parent);
                    }
                }
            } catch {
                throw Object.assign(new Error('Logout could not be saved. Please try again.'), { status: 503 });
            }
        },
        close: async () => {
            if (pool) await pool.end();
        },
    };
}
module.exports = { createRevocations };
