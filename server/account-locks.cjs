const { createHash, randomUUID } = require('node:crypto');
const LEASE_SECONDS = 30;
const DEFINITIVE = new Set([
    'PriceMoved',
    'InvalidContractProposal',
    'InvalidContractId',
    'InvalidAmount',
    'InputValidationFailed',
    'InsufficientBalance',
    'AuthorizationRequired',
    'InvalidToken',
    'PermissionDenied',
    'RateLimit',
    'TooManyRequests',
    'MarketIsClosed',
    'TradingSuspended',
    'ContractProposalExpired',
]);
const unavailable = () =>
    Object.assign(new Error('Account protection is unavailable. No new purchases are allowed.'), { status: 503 });
const conflict = () =>
    Object.assign(
        new Error(
            'This account is controlled by another trading session or has an unresolved purchase. Stop the other session and reconcile its trades first.'
        ),
        { status: 409 }
    );
function createAccountLocks({
    databaseUrl = process.env.DATABASE_URL,
    pool: suppliedPool,
    now = Date.now,
    leaseSeconds = LEASE_SECONDS,
    onFailure = () => {},
    schedule = setInterval,
    cancel = clearInterval,
} = {}) {
    const owner = randomUUID(),
        handles = new Map(),
        queues = new Map(),
        local = new Map(),
        localSettled = new Set();
    const pool =
        suppliedPool ||
        (databaseUrl
            ? new (require('pg').Pool)({
                  connectionString: databaseUrl,
                  max: 2,
                  connectionTimeoutMillis: 3000,
                  statement_timeout: 3000,
                  query_timeout: 5000,
              })
            : null);
    let lastPruned = 0;
    let ready,
        closed = false,
        healthy = true,
        closing;
    const key = account => {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(account)) throw unavailable();
        return createHash('sha256').update(account).digest('hex');
    };
    async function ensure() {
        if (closed) throw unavailable();
        if (!pool) return;
        if (!ready)
            ready = pool
                .query(
                    `DO $neto_schema$ BEGIN
                    PERFORM pg_advisory_xact_lock(1928675310);
                    CREATE TABLE IF NOT EXISTS neto_account_locks (
            account_key text PRIMARY KEY, owner text NOT NULL, token text NOT NULL,
            mode text NOT NULL, lease_until timestamptz NOT NULL,
            pending jsonb NOT NULL DEFAULT '{}', stop_requested boolean NOT NULL DEFAULT false
        );
                    CREATE TABLE IF NOT EXISTS neto_account_settlements (
            account_key text NOT NULL, contract_id bigint NOT NULL, observed_at timestamptz NOT NULL DEFAULT NOW(),
            PRIMARY KEY (account_key,contract_id)
        );
                    CREATE INDEX IF NOT EXISTS neto_account_settlements_time ON neto_account_settlements(observed_at);
                    END $neto_schema$`
                )
                .catch(() => {
                    ready = null;
                    throw unavailable();
                });
        await ready;
    }
    function serial(account, fn) {
        const previous = queues.get(account) || Promise.resolve();
        const task = previous
            .catch(() => {})
            .then(async () => {
                try {
                    await ensure();
                    const result = await fn(key(account));
                    healthy = true;
                    return result;
                } catch (error) {
                    if (error.status === 409) throw error;
                    healthy = false;
                    try {
                        onFailure('account_lock_storage');
                    } catch {}
                    throw unavailable();
                }
            });
        queues.set(account, task);
        void task
            .finally(() => {
                if (queues.get(account) === task) queues.delete(account);
            })
            .catch(() => {});
        return task;
    }
    const valid = (row, handle) => row && row.owner === owner && row.token === handle.token;
    const api = {
        mode: pool ? 'postgres' : 'local',
        health: () => healthy && !closed,
        claim(account, { mode = 'analysis', reconcile = [] } = {}) {
            return serial(account, async accountKey => {
                const existing = handles.get(account);
                if (existing?.held && !existing.lost && existing.mode !== mode) throw conflict();
                const token = randomUUID();
                const allow = [...new Set(reconcile)].filter(x => typeof x === 'string' && x.length <= 200);
                let row;
                if (pool) {
                    const result = await pool.query(
                        `INSERT INTO neto_account_locks (account_key,owner,token,mode,lease_until)
                        VALUES ($1,$2,$3,$4,NOW()+($5 * INTERVAL '1 second'))
                        ON CONFLICT (account_key) DO UPDATE SET owner=$2, token=$3, mode=$4,
                          lease_until=NOW()+($5 * INTERVAL '1 second'), stop_requested=false
                        WHERE (neto_account_locks.owner=$2 AND (neto_account_locks.pending='{}'::jsonb OR (neto_account_locks.mode='analysis' AND $4='analysis')))
                        OR (neto_account_locks.lease_until <= NOW() AND (neto_account_locks.pending='{}'::jsonb OR
                          ($4='analysis' AND NOT EXISTS (SELECT 1 FROM jsonb_each(neto_account_locks.pending) p
                            WHERE p.value->>'source' <> 'analysis' OR NOT (p.key=ANY($6::text[]))))))
                        RETURNING *`,
                        [accountKey, owner, token, mode, leaseSeconds, allow]
                    );
                    row = result.rows[0];
                } else {
                    row = local.get(accountKey);
                    const pending = row?.pending || {};
                    const canReconcile =
                        mode === 'analysis' &&
                        Object.entries(pending).every(
                            ([nonce, item]) => item.source === 'analysis' && allow.includes(nonce)
                        );
                    if (
                        row &&
                        !(
                            (row.owner === owner &&
                                (!Object.keys(pending).length || (row.mode === 'analysis' && mode === 'analysis'))) ||
                            (row.until <= now() && (!Object.keys(pending).length || canReconcile))
                        )
                    )
                        throw conflict();
                    row = { owner, token, mode, until: now() + leaseSeconds * 1000, pending, stop_requested: false };
                    local.set(accountKey, row);
                }
                if (!row) throw conflict();
                const handle = { account, owner, token, mode, held: false, lost: false, onLost: null, onStop: null };
                handles.set(account, handle);
                return handle;
            });
        },
        hold(handle, { onLost, onStop } = {}) {
            handle.held = true;
            handle.onLost = onLost;
            handle.onStop = onStop;
        },
        async protect(handle, nonce) {
            if (!handle || handle.lost || closed || typeof nonce !== 'string' || !nonce || nonce.length > 200)
                throw unavailable();
            return serial(handle.account, async accountKey => {
                const item = { owner, source: handle.mode, contractId: null };
                let ok;
                if (pool)
                    ok = (
                        await pool.query(
                            `UPDATE neto_account_locks SET pending=jsonb_set(pending,ARRAY[$4],$5::jsonb), lease_until=NOW()+($6 * INTERVAL '1 second')
                    WHERE account_key=$1 AND owner=$2 AND token=$3 AND lease_until>NOW() AND NOT stop_requested
                      AND pending='{}'::jsonb
                    RETURNING token`,
                            [accountKey, owner, handle.token, nonce, JSON.stringify(item), leaseSeconds]
                        )
                    ).rows.length;
                else {
                    const row = local.get(accountKey);
                    if (
                        valid(row, handle) &&
                        row.until > now() &&
                        !row.stop_requested &&
                        !Object.keys(row.pending).length
                    ) {
                        row.pending[nonce] = item;
                        row.until = now() + leaseSeconds * 1000;
                        ok = true;
                    }
                }
                if (!ok) throw conflict();
            });
        },
        acknowledge(handle, nonce, id, recovered = false) {
            if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(unavailable());
            return serial(handle.account, async accountKey => {
                if (pool) {
                    await pool.query(
                        `UPDATE neto_account_locks SET pending=CASE
                    WHEN EXISTS(SELECT 1 FROM neto_account_settlements WHERE account_key=$1 AND contract_id=$4) THEN pending-$3
                    ELSE jsonb_set(pending,ARRAY[$3,'contractId'],to_jsonb($4::bigint)) END
                    WHERE account_key=$1 AND pending ? $3 AND ((pending->$3->>'owner')=$2 OR
                      ($5 AND owner=$2 AND token=$6 AND pending->$3->>'source'='analysis'))`,
                        [accountKey, owner, nonce, id, recovered, handle.token]
                    );
                    // A separate fresh snapshot also covers concurrent receipt
                    // arrival while the acknowledgement waited for a row lock.
                    await pool.query(
                        `UPDATE neto_account_locks SET pending=pending-$2 WHERE account_key=$1
                        AND pending->$2->>'contractId'=$3 AND EXISTS
                        (SELECT 1 FROM neto_account_settlements WHERE account_key=$1 AND contract_id=$3::bigint)`,
                        [accountKey, nonce, String(id)]
                    );
                } else {
                    const row = local.get(accountKey),
                        item = row?.pending[nonce];
                    if (
                        item &&
                        (item.owner === owner || (recovered && valid(row, handle) && item.source === 'analysis'))
                    ) {
                        if (localSettled.has(accountKey + ':' + id)) delete row.pending[nonce];
                        else item.contractId = id;
                    }
                }
            });
        },
        cancel(handle, nonce) {
            return serial(handle.account, async accountKey => {
                if (pool)
                    await pool.query(
                        `UPDATE neto_account_locks SET pending=pending-$3
                    WHERE account_key=$1 AND pending->$3->>'owner'=$2 AND pending->$3->>'contractId' IS NULL`,
                        [accountKey, owner, nonce]
                    );
                else {
                    const row = local.get(accountKey);
                    if (row?.pending[nonce]?.owner === owner && !row.pending[nonce].contractId)
                        delete row.pending[nonce];
                }
            });
        },
        settled(account, id) {
            if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve();
            return serial(account, async accountKey => {
                if (pool) {
                    // Keep receipts to handle a settlement arriving on another
                    // socket/server before the purchase acknowledgement is saved.
                    await pool.query(
                        `INSERT INTO neto_account_settlements(account_key,contract_id) VALUES ($1,$2)
                        ON CONFLICT(account_key,contract_id) DO UPDATE SET observed_at=NOW()`,
                        [accountKey, id]
                    );
                    await pool.query(
                        `UPDATE neto_account_locks SET pending=COALESCE((SELECT jsonb_object_agg(p.key,p.value)
                        FROM jsonb_each(pending) p WHERE p.value->>'contractId' IS DISTINCT FROM $2), '{}'::jsonb)
                        WHERE account_key=$1`,
                        [accountKey, String(id)]
                    );
                } else {
                    localSettled.add(accountKey + ':' + id);
                    if (localSettled.size > 10000) localSettled.delete(localSettled.values().next().value);
                    const row = local.get(accountKey);
                    for (const [nonce, item] of Object.entries(row?.pending || {}))
                        if (item.contractId === id) delete row.pending[nonce];
                }
            });
        },
        async release(handle) {
            if (!handle) return;
            handle.held = false;
            return serial(handle.account, async accountKey => {
                if (pool)
                    await pool.query(
                        `UPDATE neto_account_locks SET lease_until=NOW()
                    WHERE account_key=$1 AND owner=$2 AND token=$3 AND pending='{}'::jsonb`,
                        [accountKey, owner, handle.token]
                    );
                else {
                    const row = local.get(accountKey);
                    if (valid(row, handle) && !Object.keys(row.pending).length) row.until = now();
                }
            });
        },
        requestStop(account) {
            return serial(account, async accountKey => {
                if (pool)
                    return !!(
                        await pool.query(
                            `UPDATE neto_account_locks SET stop_requested=true WHERE account_key=$1 AND mode='analysis' AND lease_until>NOW() RETURNING token`,
                            [accountKey]
                        )
                    ).rows.length;
                const row = local.get(accountKey);
                if (row?.mode === 'analysis' && row.until > now()) {
                    row.stop_requested = true;
                    return true;
                }
                return false;
            });
        },
        async heartbeat() {
            for (const handle of handles.values())
                if (handle.held && !handle.lost) {
                    try {
                        const row = await serial(handle.account, async accountKey => {
                            if (pool)
                                return (
                                    await pool.query(
                                        `UPDATE neto_account_locks SET lease_until=NOW()+($4 * INTERVAL '1 second')
                            WHERE account_key=$1 AND owner=$2 AND token=$3 AND lease_until>NOW() RETURNING stop_requested`,
                                        [accountKey, owner, handle.token, leaseSeconds]
                                    )
                                ).rows[0];
                            const record = local.get(accountKey);
                            if (valid(record, handle) && record.until > now()) {
                                record.until = now() + leaseSeconds * 1000;
                                return record;
                            }
                        });
                        if (!row) throw conflict();
                        if (row.stop_requested) handle.onStop?.();
                    } catch {
                        handle.lost = true;
                        handle.held = false;
                        try {
                            handle.onLost?.();
                        } catch {}
                    }
                }
        },
        async probe() {
            await ensure();
            if (pool) await pool.query('SELECT 1');
            if (pool && now() - lastPruned > 60000) {
                await pool.query(`DELETE FROM neto_account_settlements WHERE ctid IN
                    (SELECT ctid FROM neto_account_settlements WHERE observed_at<NOW()-INTERVAL '1 day' LIMIT 10000)`);
                lastPruned = now();
            }
            return { mode: api.mode, healthy: healthy && !closed };
        },
        current(account) {
            return serial(account, async accountKey => {
                if (pool)
                    return (
                        (
                            await pool.query(
                                'SELECT mode, lease_until>NOW() AS active FROM neto_account_locks WHERE account_key=$1',
                                [accountKey]
                            )
                        ).rows[0] || { active: false }
                    );
                const row = local.get(accountKey);
                return { mode: row?.mode, active: !!row && row.until > now() };
            });
        },
        async summary() {
            await ensure();
            if (!pool)
                return {
                    mode: 'local',
                    active: [...handles.values()].filter(h => h.held && !h.lost).length,
                    pending: [...local.values()].reduce((n, r) => n + Object.keys(r.pending).length, 0),
                    unresolved: [...local.values()]
                        .filter(r => r.until <= now())
                        .reduce((n, r) => n + Object.keys(r.pending).length, 0),
                };
            const result =
                await pool.query(`SELECT count(*) FILTER(WHERE lease_until>NOW())::int AS active, COALESCE(sum(jsonb_object_length),0)::int AS pending, COALESCE(sum(jsonb_object_length) FILTER (WHERE lease_until<=NOW()),0)::int AS unresolved FROM
                (SELECT lease_until,(SELECT count(*)::int FROM jsonb_object_keys(pending)) AS jsonb_object_length FROM neto_account_locks) s`);
            return { mode: 'postgres', ...result.rows[0] };
        },
        async close() {
            if (closing) return closing;
            closing = (async () => {
                cancel(timer);
                for (const handle of handles.values()) handle.held = false;
                await Promise.allSettled([...queues.values()]);
                closed = true;
                if (pool && !suppliedPool) await pool.end();
            })();
            return closing;
        },
    };
    let ticking = false;
    const timer = schedule(() => {
        if (ticking) return;
        ticking = true;
        void api
            .heartbeat()
            .finally(() => {
                ticking = false;
            })
            .catch(() => {});
    }, 5000);
    timer?.unref?.();
    return api;
}
module.exports = { createAccountLocks, DEFINITIVE };
