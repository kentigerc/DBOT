// Private, bounded operational diagnostics. No tokens, connection URLs or raw
// driver/provider errors are returned or logged by this module.
function createOperations({
    trading,
    analytics,
    origin,
    nodeVersion = process.versions.node,
    now = Date.now,
    log = event => console.warn(JSON.stringify(event)),
    cacheMs = 30000,
} = {}) {
    const alerts = [],
        previous = new Map();
    let sequence = 0,
        cached,
        pending,
        drops = 0,
        lastDrop = 0,
        lastLockLoss = 0;
    const record = (code, status, message) => {
        if (previous.get(code) === status) return;
        previous.set(code, status);
        if (status === 'ok' && !alerts.some(item => item.code === code)) return;
        const entry = { id: ++sequence, code, status, message, at: now() };
        alerts.unshift(entry);
        if (alerts.length > 100) alerts.pop();
        try {
            log({ event: 'neto_operations_alert', code, status, at: entry.at });
        } catch {}
    };
    return {
        record(event) {
            cached = undefined;
            if (event === 'account_lock_lost') {
                lastLockLoss = now();
                record(
                    'lock_ownership',
                    'warning',
                    'A trading session lost its account lock. New entries were stopped.'
                );
                return;
            }
            if (event === 'trading_connection_lost') {
                drops++;
                lastDrop = now();
                record(
                    'deriv_connections',
                    'warning',
                    'A trading connection was interrupted. Check open contracts in Reports.'
                );
            } else if (event === 'account_lock_storage')
                record(
                    'account_locks',
                    'error',
                    'Account protection could not reach storage. New purchases are blocked.'
                );
        },
        async get() {
            if (cached && now() - cached.checkedAt < cacheMs) return { ...cached, alerts: [...alerts] };
            if (pending) return pending;
            pending = (async () => {
                const checks = [];
                const add = (code, status, message) => {
                    checks.push({ code, status, message });
                    record(code, status, message);
                };
                add(
                    'node_runtime',
                    Number(nodeVersion.split('.')[0]) === 24 ? 'ok' : 'warning',
                    Number(nodeVersion.split('.')[0]) === 24
                        ? 'Node 24 runtime is active.'
                        : 'Configure the supported Node 24 runtime.'
                );
                add(
                    'secure_origin',
                    origin?.startsWith('https://') ? 'ok' : 'warning',
                    origin?.startsWith('https://')
                        ? 'The configured application origin uses HTTPS.'
                        : 'The configured application origin does not use HTTPS.'
                );
                let state;
                try {
                    state = await trading();
                    add(
                        'trading_database',
                        state.journal.mode === 'postgres' && !state.journal.failedAccounts ? 'ok' : 'warning',
                        state.journal.mode !== 'postgres'
                            ? 'Trading journals use local files. Configure DATABASE_URL for durable storage.'
                            : state.journal.failedAccounts
                              ? 'Some account journals require recovery before new trading.'
                              : 'Trading-state database probe passed.'
                    );
                    add(
                        'account_locks',
                        state.protection.mode === 'postgres' && state.protection.healthy ? 'ok' : 'warning',
                        state.protection.mode !== 'postgres'
                            ? 'Account locks are local to this process. Shared protection requires PostgreSQL.'
                            : state.protection.healthy
                              ? 'Shared account-protection probe passed.'
                              : 'Shared account protection requires review.'
                    );
                    add(
                        'pending_purchases',
                        state.locks.unresolved ? 'warning' : 'ok',
                        state.locks.unresolved
                            ? 'Purchases remain unresolved after their session lease expired. Review Reports before restarting those accounts.'
                            : 'No expired sessions have unresolved purchases.'
                    );
                } catch {
                    add(
                        'trading_database',
                        'error',
                        'Trading storage/protection probes failed. New purchases fail closed.'
                    );
                }
                try {
                    const store = await analytics();
                    add(
                        'analytics_storage',
                        store.mode === 'postgres' && store.healthy ? 'ok' : 'warning',
                        store.healthy
                            ? store.mode === 'postgres'
                                ? 'Analytics database probe passed.'
                                : 'Analytics uses local preview storage.'
                            : 'Analytics storage requires review.'
                    );
                } catch {
                    add('analytics_storage', 'error', 'Analytics storage probe failed. Reports may be delayed.');
                }
                add(
                    'lock_ownership',
                    lastLockLoss && now() - lastLockLoss < 300000 ? 'warning' : 'ok',
                    lastLockLoss && now() - lastLockLoss < 300000
                        ? 'A trading session lost its account lock and stopped new entries. Review before restarting.'
                        : 'No recent account-lock loss was observed on this instance.'
                );
                add(
                    'deriv_connections',
                    lastDrop && now() - lastDrop < 300000 ? 'warning' : 'ok',
                    lastDrop && now() - lastDrop < 300000
                        ? 'A trading connection was interrupted within the last five minutes. Review open contracts.'
                        : 'No recent trading-connection interruption was observed on this instance.'
                );
                cached = {
                    checkedAt: now(),
                    status: checks.some(item => item.status === 'error')
                        ? 'error'
                        : checks.some(item => item.status === 'warning')
                          ? 'warning'
                          : 'ok',
                    checks,
                    activeServerBots: state?.active ?? null,
                    protectedAccounts: state?.locks.active ?? null,
                    pendingPurchases: state?.locks.pending ?? null,
                    connectionDrops: drops,
                    scope: 'Runtime checks are per server instance; PostgreSQL lock counts are shared. DNS, backups, MFA, WAF and external uptime are not verified.',
                };
                return { ...cached, alerts: [...alerts] };
            })().finally(() => {
                pending = null;
            });
            return pending;
        },
    };
}
module.exports = { createOperations };
