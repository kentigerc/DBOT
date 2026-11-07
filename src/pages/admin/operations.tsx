import { useEffect, useState } from 'react';
type Health = {
    status: string;
    checkedAt: number;
    checks: { code: string; status: string; message: string }[];
    alerts: { id: number; code: string; status: string; message: string; at: number }[];
    activeServerBots: number | null;
    protectedAccounts: number | null;
    pendingPurchases: number | null;
    connectionDrops: number;
    scope: string;
};
export default function Operations() {
    const [data, setData] = useState<Health | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [refresh, setRefresh] = useState(0);
    useEffect(() => {
        let live = true;
        const controller = new AbortController();
        const load = async () => {
            if (live) setBusy(true);
            try {
                const response = await fetch('/api/admin/health', {
                    credentials: 'same-origin',
                    cache: 'no-store',
                    signal: controller.signal,
                });
                const value = await response.json();
                if (!response.ok) throw new Error(value.error || 'Unable to check platform health.');
                if (!Array.isArray(value.checks) || !Array.isArray(value.alerts))
                    throw new Error('Unable to check platform health.');
                if (live) {
                    setData(value);
                    setError('');
                }
            } catch (reason) {
                if (live) {
                    setData(null);
                    setError(reason instanceof Error ? reason.message : 'Health checks are unavailable.');
                }
            } finally {
                if (live) setBusy(false);
            }
        };
        void load();
        const timer = window.setInterval(() => void load(), 30000);
        return () => {
            live = false;
            controller.abort();
            window.clearInterval(timer);
        };
    }, [refresh]);
    return (
        <section className='neto-admin__operations' aria-label='Platform health'>
            <div className='neto-admin__operations-heading'>
                <h2>Platform health</h2>
                <button type='button' disabled={busy} onClick={() => setRefresh(value => value + 1)}>
                    {busy ? 'Checking health…' : 'Refresh health'}
                </button>
            </div>
            {error && (
                <p role='status' className='neto-admin__notice'>
                    {error}
                </p>
            )}
            {data && (
                <>
                    <p>
                        Owner-only checks · Updated {new Date(data.checkedAt).toLocaleString()} · Refreshes every 30
                        seconds.
                    </p>
                    <ul className='neto-admin__health-checks'>
                        {data.checks.map(check => (
                            <li key={check.code} data-status={check.status}>
                                <strong>
                                    {check.status === 'ok'
                                        ? 'OK'
                                        : check.status === 'error'
                                          ? 'Action needed'
                                          : 'Review'}
                                </strong>
                                <span>{check.message}</span>
                            </li>
                        ))}
                    </ul>
                    <p>
                        Protected accounts: {data.protectedAccounts ?? 'Unavailable'} · Pending purchases:{' '}
                        {data.pendingPurchases ?? 'Unavailable'} · Observed connection interruptions:{' '}
                        {data.connectionDrops}
                    </p>
                    <h3>Recent operational alerts</h3>
                    {data.alerts.length ? (
                        <ul className='neto-admin__health-alerts'>
                            {data.alerts.slice(0, 10).map(alert => (
                                <li key={alert.id}>
                                    <time>{new Date(alert.at).toLocaleString()}</time> · {alert.message}
                                    {alert.status === 'ok' ? ' — recovered' : ''}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p>No operational alerts have been recorded on this server instance.</p>
                    )}
                    <p>{data.scope}</p>
                    <p>Alerts appear here and in server logs. External email/SMS notifications are not configured.</p>
                </>
            )}
        </section>
    );
}
