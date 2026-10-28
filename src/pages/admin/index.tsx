import { useCallback, useEffect, useRef, useState } from 'react';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import './admin.scss';

type Overview = {
    visitors: number;
    connectedAccounts: number;
    tradingAccounts: number;
    trades: number;
    hiddenDemoTrades?: number;
    onlineBrowsers: number;
    onlineAuthenticatedBrowsers: number;
    liveDerivConnections: number;
    liveConnectedAccounts: number;
    activeServerBots: number;
    storage: string;
    healthy: boolean;
    pendingEvents: number;
    droppedEvents?: number;
    generatedAt: number;
    daily: { date: string; visitors: number; connections: number; trades: number }[];
    tools: { tool: string; sessions: number }[];
    tradingTools?: {
        tool: string;
        accountType: string;
        currency: string;
        trades: number;
        volume: number;
        net: number;
    }[];
    tradingUsers?: (Overview['money'][number] & { account: string })[];
    money: {
        accountType: string;
        currency: string;
        trades: number;
        volume: number;
        net: number;
        settled: number;
        wins: number;
        losses: number;
        open: number;
    }[];
};
type Commission = {
    reported: boolean;
    commissionUsd: number | null;
    volumeUsd: number | null;
    contracts: number | null;
    clients: number | null;
    fetchedAt: number;
    source: string;
    appId: string;
    points?: { from: string; to: string; reported: boolean; commissionUsd: number | null }[];
};
const date = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const labels: Record<string, string> = {
    dashboard: 'Dashboard',
    bot_builder: 'Bot Builder',
    chart: 'Charts',
    digit_analysis: 'Digit Analysis',
    deriv_charts: 'Tradingview',
    free_bots: 'Free Bots',
    analysis_tool: 'Analysis Tool',
    hit_and_run: 'HIT AND RUN',
    even_odd: 'Even / Odd',
};
async function get<T>(path: string): Promise<T> {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json();
    if (!response.ok)
        throw Object.assign(new Error(body.error || 'Unable to load analytics.'), { status: response.status });
    return body;
}
const usd = (value: number | null) =>
    value === null
        ? 'Not reported'
        : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
function exportCsv(data: Overview, from: string, to: string) {
    const rows = [
        ['Date (UTC)', 'Browser visitors', 'Connected accounts', 'Contracts purchased'],
        ...data.daily.map(row => [row.date, row.visitors, row.connections, row.trades]),
    ];
    const content = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `netoacademy-analytics-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
}
export default function Admin() {
    const panel = useMarketPanelHeight<HTMLElement>();
    const [from, setFrom] = useState(date(-29)),
        [to, setTo] = useState(date());
    const [data, setData] = useState<Overview | null>(null),
        [commission, setCommission] = useState<Commission | null>(null);
    const [error, setError] = useState(''),
        [reportError, setReportError] = useState(''),
        [busy, setBusy] = useState(false),
        [allowed, setAllowed] = useState(false);
    const [breakdown, setBreakdown] = useState('none');
    const reportSequence = useRef(0);
    const [reportBusy, setReportBusy] = useState(false);
    const [range, setRange] = useState({ from: date(-29), to: date() });
    useEffect(() => {
        let live = true;
        get('/api/admin/access')
            .then(() => {
                if (live) setAllowed(true);
            })
            .catch(reason => {
                if (live) setError(reason.message);
            });
        return () => {
            live = false;
        };
    }, []);
    useEffect(() => {
        if (!allowed) return;
        let live = true;
        const query = new URLSearchParams(range).toString();
        const load = async () => {
            if (live) setBusy(true);
            try {
                const value = await get<Overview>(`/api/admin/overview?${query}`);
                if (live) {
                    setData(value);
                    setError('');
                }
            } catch (reason) {
                if (live) {
                    setError(reason instanceof Error ? reason.message : 'Unable to load analytics.');
                    if ([401, 403].includes((reason as { status?: number }).status || 0)) {
                        setAllowed(false);
                        setData(null);
                        setCommission(null);
                    }
                }
            } finally {
                if (live) setBusy(false);
            }
        };
        void load();
        const interval = window.setInterval(() => void load(), 60000);
        return () => {
            live = false;
            window.clearInterval(interval);
        };
    }, [allowed, range]);
    const refreshCommission = async () => {
        const sequence = ++reportSequence.current;
        setReportError('');
        setCommission(null);
        setReportBusy(true);
        try {
            const value = await get<Commission>(
                `/api/admin/commission?${new URLSearchParams({ ...range, breakdown })}`
            );
            if (sequence === reportSequence.current) setCommission(value);
        } catch (reason) {
            if (sequence === reportSequence.current)
                setReportError(reason instanceof Error ? reason.message : 'Unable to load commission.');
        } finally {
            if (sequence === reportSequence.current) setReportBusy(false);
        }
    };
    const invalidateCommission = useCallback(() => {
        reportSequence.current++;
    }, []);
    useEffect(() => {
        invalidateCommission();
        setCommission(null);
        setReportError('');
        setReportBusy(false);
        return invalidateCommission;
    }, [range, breakdown, invalidateCommission]);
    return (
        <main className='neto-admin' ref={panel}>
            <div className='neto-admin__heading'>
                <div>
                    <p className='neto-admin__eyebrow'>OWNER DASHBOARD</p>
                    <h1>NetoAcademy analytics</h1>
                    <p>Site activity, confirmed trades and Deriv-reported commission.</p>
                </div>
                <a href='/#bot_builder'>Return to trading</a>
            </div>
            {error && (
                <p role='alert' className='neto-admin__notice'>
                    {error}
                </p>
            )}
            {!allowed ? (
                <section className='neto-admin__panel'>
                    <h2>Private admin access</h2>
                    <p>
                        Sign in with the owner’s authorized Deriv account. Admin access must be configured on the
                        server.
                    </p>
                    <a className='neto-admin__button' href='/api/auth/login?return=admin'>
                        Log in with Deriv
                    </a>
                </section>
            ) : (
                <>
                    <form
                        className='neto-admin__filters'
                        onSubmit={event => {
                            event.preventDefault();
                            setData(null);
                            setRange({ from, to });
                        }}
                    >
                        <label>
                            From (UTC)
                            <input type='date' value={from} onChange={e => setFrom(e.target.value)} required />
                        </label>
                        <label>
                            To (UTC)
                            <input type='date' value={to} onChange={e => setTo(e.target.value)} required />
                        </label>
                        <button disabled={busy}>Apply dates</button>
                        <button
                            type='button'
                            disabled={!data}
                            onClick={() => data && exportCsv(data, range.from, range.to)}
                        >
                            Export daily CSV
                        </button>
                    </form>
                    {data?.storage === 'preview-file' && (
                        <p className='neto-admin__notice'>
                            Preview storage: history survives a process restart, but Render can erase it on a redeploy.
                            Connect PostgreSQL with DATABASE_URL for durable analytics.
                        </p>
                    )}
                    {data && (!data.healthy || data.pendingEvents > 0) && (
                        <p role='status' className='neto-admin__notice'>
                            {data.droppedEvents
                                ? 'Some tracking events could not be recorded; totals may be incomplete.'
                                : `Analytics is catching up. ${data.pendingEvents} events are pending; totals may be incomplete.`}
                        </p>
                    )}
                    <section className='neto-admin__cards' aria-label='Live activity'>
                        {[
                            ['Online browsers', data?.onlineBrowsers],
                            ['Signed-in browsers', data?.onlineAuthenticatedBrowsers],
                            ['Live Deriv connections', data?.liveDerivConnections],
                            ['Connected accounts now', data?.liveConnectedAccounts],
                            ['Active server bots', data?.activeServerBots],
                        ].map(([label, value]) => (
                            <article key={label}>
                                <span>{label}</span>
                                <strong>{value ?? '—'}</strong>
                            </article>
                        ))}
                    </section>
                    <p className='neto-admin__hint'>
                        Online browsers sent a heartbeat within 90 seconds. Browser counts are estimates; devices and
                        accounts are counted separately. Live cards ignore the date filter.
                    </p>
                    <section className='neto-admin__cards' aria-label='Period activity'>
                        {[
                            ['Browser visitors', data?.visitors],
                            ['Connected Deriv accounts', data?.connectedAccounts],
                            ['Trading accounts', data?.tradingAccounts],
                            ['Confirmed purchases', data?.trades],
                        ].map(([label, value]) => (
                            <article key={label}>
                                <span>{label}</span>
                                <strong>{value ?? '—'}</strong>
                            </article>
                        ))}
                    </section>
                    <p className='neto-admin__hint'>
                        Demo activity is shown until that user makes a real-account trade. Their demo history is then
                        hidden from trading totals and tables; other demo users remain visible.
                        {!!data?.hiddenDemoTrades && ` ${data.hiddenDemoTrades} demo trades hidden for these dates.`}
                    </p>
                    <section className='neto-admin__panel'>
                        <div className='neto-admin__heading'>
                            <div>
                                <h2>Application commission</h2>
                                <p>Deriv-reported totals for the selected dates, in USD. No estimated deductions.</p>
                            </div>
                            <a href='/api/auth/login?admin=1'>Connect developer reporting</a>
                        </div>
                        <label className='neto-admin__breakdown'>
                            Commission detail
                            <select value={breakdown} onChange={event => setBreakdown(event.target.value)}>
                                <option value='none'>Period total</option>
                                <option value='daily'>Daily (up to 31 days)</option>
                                <option value='monthly'>Monthly</option>
                            </select>
                        </label>
                        <button disabled={reportBusy} onClick={() => void refreshCommission()}>
                            {reportBusy ? 'Loading commission…' : 'Refresh commission'}
                        </button>
                        {reportError && <p role='alert'>{reportError}</p>}
                        {commission ? (
                            <>
                                <div className='neto-admin__cards'>
                                    <article>
                                        <span>Reported markup</span>
                                        <strong>{usd(commission.commissionUsd)}</strong>
                                    </article>
                                    <article>
                                        <span>Reported volume</span>
                                        <strong>{usd(commission.volumeUsd)}</strong>
                                    </article>
                                    <article>
                                        <span>Reported contracts</span>
                                        <strong>{commission.contracts ?? '—'}</strong>
                                    </article>
                                    <article>
                                        <span>Reported clients</span>
                                        <strong>{commission.clients ?? '—'}</strong>
                                    </article>
                                </div>
                                {commission.points && commission.points.length > 0 && (
                                    <div className='neto-admin__table' tabIndex={0} aria-label='Commission breakdown'>
                                        <table>
                                            <thead>
                                                <tr>
                                                    <th>From (UTC)</th>
                                                    <th>To (UTC)</th>
                                                    <th>Reported markup (USD)</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {commission.points.map(point => (
                                                    <tr key={point.from}>
                                                        <td>{point.from}</td>
                                                        <td>{point.to}</td>
                                                        <td>{usd(point.commissionUsd)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                                <p className='neto-admin__hint'>
                                    Source: {commission.source} · App {commission.appId} · Checked{' '}
                                    {new Date(commission.fetchedAt).toLocaleString()}.{' '}
                                    {!commission.reported &&
                                        'Deriv returned no row for this app in the selected period.'}
                                </p>
                            </>
                        ) : (
                            <p className='neto-admin__hint'>
                                Connect the app owner’s application_read authorization, then refresh. Commission is not
                                loaded automatically and may be reported with a delay.
                            </p>
                        )}
                    </section>
                    <div className='neto-admin__columns'>
                        <section className='neto-admin__panel'>
                            <h2>Daily activity</h2>
                            <div className='neto-admin__bars' aria-label='Daily browser visitor chart'>
                                {data?.daily.map(row => (
                                    <div key={row.date}>
                                        <span>{row.date.slice(5)}</span>
                                        <span
                                            className='neto-admin__bar'
                                            style={{
                                                width: `${Math.max(1, (row.visitors / Math.max(1, ...data.daily.map(d => d.visitors))) * 80)}%`,
                                            }}
                                        />
                                        <strong>{row.visitors}</strong>
                                    </div>
                                ))}
                            </div>
                            {data?.daily.length === 0 && <p>No activity recorded for these dates.</p>}
                        </section>
                        <section className='neto-admin__panel'>
                            <h2>Tool usage</h2>
                            <p className='neto-admin__hint'>
                                Distinct browser/tool combinations per day, summed over the period.
                            </p>
                            <div className='neto-admin__table'>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Tool</th>
                                            <th>Daily browser sessions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data?.tools.map(row => (
                                            <tr key={row.tool}>
                                                <td>{labels[row.tool] || row.tool}</td>
                                                <td>{row.sessions}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                    </div>
                    <section className='neto-admin__panel'>
                        <h2>Trading volume and results</h2>
                        <p className='neto-admin__hint'>
                            Confirmed server-observed contracts, grouped by purchase date. Demo and real totals stay
                            separate; values are never added across currencies. Open contracts have no final P/L.
                        </p>
                        <div
                            className='neto-admin__table'
                            tabIndex={0}
                            aria-label='Trading results, scroll horizontally'
                        >
                            <table>
                                <thead>
                                    <tr>
                                        {[
                                            'Account',
                                            'Currency',
                                            'Purchases',
                                            'Settled',
                                            'Wins',
                                            'Losses',
                                            'Open',
                                            'Volume',
                                            'Trader net P/L',
                                        ].map(label => (
                                            <th key={label}>{label}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data?.money.map(row => (
                                        <tr key={row.accountType + row.currency}>
                                            <td>
                                                <span
                                                    className={`neto-admin__badge neto-admin__badge--${row.accountType}`}
                                                >
                                                    {row.accountType}
                                                </span>
                                            </td>
                                            <td>{row.currency}</td>
                                            <td>{row.trades}</td>
                                            <td>{row.settled}</td>
                                            <td>{row.wins}</td>
                                            <td>{row.losses}</td>
                                            <td>{row.open}</td>
                                            <td>{(row.volume / 100).toFixed(2)}</td>
                                            <td className={row.net < 0 ? 'neto-admin__loss' : 'neto-admin__profit'}>
                                                {(row.net / 100).toFixed(2)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {data?.money.length === 0 && <p>No confirmed trading activity recorded for these dates.</p>}
                    </section>
                    <section className='neto-admin__panel'>
                        <h2>Trading by user</h2>
                        <p className='neto-admin__hint'>
                            Each reference identifies one Deriv account, not a person. References stay consistent across
                            devices. Demo and real accounts are separate. Volume is confirmed trading activity, not
                            commission contribution; Deriv reports commission for the whole app.
                        </p>
                        <div
                            className='neto-admin__table'
                            tabIndex={0}
                            aria-label='Trading by user, scroll horizontally'
                        >
                            <table>
                                <thead>
                                    <tr>
                                        {[
                                            'Account reference',
                                            'Account',
                                            'Currency',
                                            'Purchases',
                                            'Settled',
                                            'Wins',
                                            'Losses',
                                            'Open',
                                            'Volume',
                                            'Trader net P/L',
                                        ].map(label => (
                                            <th key={label}>{label}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {data?.tradingUsers?.map(row => (
                                        <tr key={row.account + row.accountType + row.currency}>
                                            <td title={row.account}>User {row.account.slice(0, 16)}</td>
                                            <td>
                                                <span
                                                    className={`neto-admin__badge neto-admin__badge--${row.accountType}`}
                                                >
                                                    {row.accountType}
                                                </span>
                                            </td>
                                            <td>{row.currency}</td>
                                            <td>{row.trades}</td>
                                            <td>{row.settled}</td>
                                            <td>{row.wins}</td>
                                            <td>{row.losses}</td>
                                            <td>{row.open}</td>
                                            <td>{(row.volume / 100).toFixed(2)}</td>
                                            <td className={row.net < 0 ? 'neto-admin__loss' : 'neto-admin__profit'}>
                                                {(row.net / 100).toFixed(2)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {!data?.tradingUsers?.length && <p>No confirmed trading activity recorded for these dates.</p>}
                    </section>
                    <section className='neto-admin__panel'>
                        <h2>Trading by tool</h2>
                        <div
                            className='neto-admin__table'
                            tabIndex={0}
                            aria-label='Trading by tool, scroll horizontally'
                        >
                            <table>
                                <thead>
                                    <tr>
                                        <th>Tool</th>
                                        <th>Account</th>
                                        <th>Currency</th>
                                        <th>Purchases</th>
                                        <th>Volume</th>
                                        <th>Trader net P/L</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data?.tradingTools?.map(row => (
                                        <tr key={row.tool + row.accountType + row.currency}>
                                            <td>{labels[row.tool] || row.tool}</td>
                                            <td>{row.accountType}</td>
                                            <td>{row.currency}</td>
                                            <td>{row.trades}</td>
                                            <td>{(row.volume / 100).toFixed(2)}</td>
                                            <td className={row.net < 0 ? 'neto-admin__loss' : 'neto-admin__profit'}>
                                                {(row.net / 100).toFixed(2)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className='neto-admin__hint'>
                            Totals cover all recorded users and sessions in the selected dates. The confirmed purchase
                            determines the tool, even if another connection observes its settlement. Deriv commission is
                            reported for the app as a whole.
                        </p>
                    </section>
                    {data && (
                        <p className='neto-admin__hint'>
                            Updated {new Date(data.generatedAt).toLocaleString()} · Usage refreshes every minute ·
                            Storage: {data.storage}. History begins when tracking is enabled; it does not reconstruct
                            previous visitors.
                        </p>
                    )}
                </>
            )}
        </main>
    );
}
