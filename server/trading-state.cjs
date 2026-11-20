const { createHash } = require('node:crypto');

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const storageError = () =>
    Object.assign(new Error('Trading state storage is unavailable. No new purchases are allowed.'), { status: 503 });
const conflictError = () =>
    Object.assign(new Error('Trading state changed on another server. Stop and reload before continuing.'), {
        status: 409,
    });

// The engine's synchronous Storage interface reads from an explicitly hydrated
// cache. flush(key) is the durability barrier used BEFORE sending a purchase.
function createTradingStateStorage({ databaseUrl = process.env.DATABASE_URL, legacyStorage, pool: suppliedPool } = {}) {
    if (!databaseUrl && !suppliedPool) return Object.assign(legacyStorage, { mode: 'preview-file' });
    const pool =
        suppliedPool ||
        new (require('pg').Pool)({
            connectionString: databaseUrl,
            max: 3,
            connectionTimeoutMillis: 5000,
            statement_timeout: 5000,
            query_timeout: 8000,
        });
    const records = new Map(),
        loading = new Map();
    let ready,
        closing,
        closed = false;
    const hash = key => createHash('sha256').update(key).digest('hex');
    const validate = (key, value) => {
        if (
            !/^neto\.digit-strategy\.v1\.[A-Za-z0-9_-]{1,128}$/.test(key) ||
            typeof value !== 'string' ||
            Buffer.byteLength(value) > MAX_STATE_BYTES
        )
            throw storageError();
        const data = JSON.parse(value);
        if (!data || Array.isArray(data) || data.version !== 1 || `neto.digit-strategy.v1.${data.accountId}` !== key)
            throw storageError();
        return data;
    };
    const ensureReady = async () => {
        if (closed) throw storageError();
        if (!ready)
            ready = pool
                .query(
                    `CREATE TABLE IF NOT EXISTS neto_trading_state (
            state_key text PRIMARY KEY,
            revision bigint NOT NULL CHECK (revision > 0),
            data jsonb NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT NOW()
        )`
                )
                .catch(() => {
                    ready = null;
                    throw storageError();
                });
        await ready;
    };
    const get = key => {
        const record = records.get(key);
        if (closed || !record) throw storageError(); // Never treat an unread database as an empty account.
        if (record.error) throw record.error;
        return record;
    };
    const notify = record => {
        for (const waiter of [...record.waiters]) {
            if (record.error || waiter.sequence <= record.committed) {
                record.waiters.delete(waiter);
                record.error ? waiter.reject(record.error) : waiter.resolve();
            }
        }
    };
    const drain = async (key, record) => {
        if (record.running) return;
        record.running = true;
        try {
            while (record.wanted && !record.error) {
                const { value, sequence } = record.wanted;
                record.wanted = null;
                // Revision checks fence stale state writers; they are not a
                // distributed account lock for browser Builder/XML purchases.
                const result =
                    record.revision === '0'
                        ? await pool.query(
                              `INSERT INTO neto_trading_state (state_key, revision, data)
                        VALUES ($1,1,$2) ON CONFLICT (state_key) DO NOTHING RETURNING revision`,
                              [hash(key), value]
                          )
                        : await pool.query(
                              `UPDATE neto_trading_state SET data=$2, revision=revision+1, updated_at=NOW()
                        WHERE state_key=$1 AND revision=$3 RETURNING revision`,
                              [hash(key), value, record.revision]
                          );
                if (!result.rows.length) throw conflictError();
                record.revision = String(result.rows[0].revision);
                record.committed = sequence;
                notify(record);
            }
        } catch (error) {
            record.error = error.status === 409 ? error : storageError();
            record.wanted = null;
            notify(record);
        } finally {
            record.running = false;
        }
    };
    const storage = {
        mode: 'postgres',
        async peek(key) {
            await ensureReady();
            const result = await pool.query('SELECT data FROM neto_trading_state WHERE state_key=$1', [hash(key)]);
            const value = result.rows[0] ? JSON.stringify(result.rows[0].data) : null;
            if (value !== null) validate(key, value);
            return value;
        },
        async reload(key) {
            const record = records.get(key);
            if (record?.running || record?.wanted) await storage.flush(key);
            records.delete(key);
            await storage.load(key);
        },
        async probe() {
            await ensureReady();
            await pool.query('SELECT 1');
            return { mode: 'postgres', failedAccounts: [...records.values()].filter(record => record.error).length };
        },
        async load(key) {
            if (records.has(key)) {
                get(key);
                return;
            }
            if (loading.has(key)) return loading.get(key);
            const task = (async () => {
                await ensureReady();
                if (!/^neto\.digit-strategy\.v1\.[A-Za-z0-9_-]{1,128}$/.test(key)) throw storageError();
                let result = await pool.query('SELECT data, revision FROM neto_trading_state WHERE state_key=$1', [
                    hash(key),
                ]);
                if (!result.rows.length) {
                    const legacy = legacyStorage?.getItem(key);
                    if (legacy !== null && legacy !== undefined) {
                        validate(key, legacy);
                        await pool.query(
                            `INSERT INTO neto_trading_state (state_key, revision, data)
                            VALUES ($1,1,$2) ON CONFLICT (state_key) DO NOTHING`,
                            [hash(key), legacy]
                        );
                        result = await pool.query('SELECT data, revision FROM neto_trading_state WHERE state_key=$1', [
                            hash(key),
                        ]);
                    }
                }
                const row = result.rows[0],
                    value = row ? JSON.stringify(row.data) : null;
                if (row) validate(key, value);
                records.set(key, {
                    value,
                    revision: String(row?.revision || '0'),
                    sequence: 0,
                    committed: 0,
                    running: false,
                    wanted: null,
                    error: null,
                    waiters: new Set(),
                });
            })()
                .catch(() => {
                    throw storageError();
                })
                .finally(() => loading.delete(key));
            loading.set(key, task);
            return task;
        },
        getItem(key) {
            return get(key).value;
        },
        setItem(key, value) {
            const record = get(key);
            validate(key, value);
            record.value = value;
            record.wanted = { value, sequence: ++record.sequence };
            // A blocked database can retain only one in-flight and one latest
            // snapshot per account, rather than an unbounded heartbeat queue.
            void drain(key, record);
        },
        flush(key) {
            const record = get(key),
                sequence = record.sequence;
            if (record.committed >= sequence) return Promise.resolve();
            return new Promise((resolve, reject) => record.waiters.add({ sequence, resolve, reject }));
        },
        async close() {
            if (closing) return closing;
            closing = (async () => {
                try {
                    await Promise.allSettled([...loading.values()]);
                    await Promise.allSettled(
                        [...records.keys()].map(key => {
                            try {
                                return storage.flush(key);
                            } catch (error) {
                                return Promise.reject(error);
                            }
                        })
                    );
                } finally {
                    closed = true;
                    if (!suppliedPool) await pool.end();
                }
            })();
            return closing;
        },
    };
    return storage;
}
module.exports = { createTradingStateStorage, MAX_STATE_BYTES };
