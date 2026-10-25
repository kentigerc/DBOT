import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { RECOVERY_MODES, type Settings } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession, refreshDerivSession, startDerivLogin } from '@/utils/deriv-session';
import './analysis-tool.scss';

const money = (value: number) => `$${(value / 100).toFixed(2)}`;
const time = (value: number) =>
    new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value);
export default function AnalysisTool() {
    const state = useSyncExternalStore(digitStrategyEngine.subscribe, digitStrategyEngine.getSnapshot);
    const panel = useMarketPanelHeight<HTMLDivElement>();
    const [draft, setDraft] = useState<Settings>({ ...state.settings });
    const [session, setSession] = useState(getDerivSession());
    const [error, setError] = useState('');
    const [terminal, setTerminal] = useState(false);
    const [contractId, setContractId] = useState('');
    const [marketFilter, setMarketFilter] = useState('');
    const dialog = useRef<HTMLDialogElement>(null);
    const output = useRef<HTMLDivElement>(null);
    const account = getDerivAccount();
    useEffect(() => {
        const update = () => {
            setSession(getDerivSession());
            try {
                digitStrategyEngine.selectAccount(getDerivAccount());
                setDraft({ ...digitStrategyEngine.getSnapshot().settings });
            } catch (reason) {
                setError(reason instanceof Error ? reason.message : 'Unable to restore this session.');
            }
        };
        update();
        window.addEventListener('neto-session', update);
        refreshDerivSession().catch(reason => setError(reason.message));
        return () => window.removeEventListener('neto-session', update);
    }, []);
    useEffect(() => {
        if (terminal && !dialog.current?.open) dialog.current?.showModal();
        if (!terminal && dialog.current?.open) dialog.current?.close();
    }, [terminal]);
    useEffect(() => {
        if (output.current && terminal) output.current.scrollTop = output.current.scrollHeight;
    }, [state.logs, terminal]);
    const run = async (reconcile?: number) => {
        setError('');
        try {
            await digitStrategyEngine.start(
                reconcile ? state.settings : { ...draft, strategy: undefined, hitRecovery: undefined },
                reconcile
            );
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Unable to start strategy.');
        }
    };
    const reset = async () => {
        setError('');
        try {
            await digitStrategyEngine.reset();
            setDraft({ ...digitStrategyEngine.getSnapshot().settings });
        } catch (reason) {
            setError((reason as Error).message);
        }
    };
    useEffect(() => {
        if (state.active || state.pending || state.trades.length) setDraft({ ...state.settings });
    }, [state.active, state.settings, state.pending, state.trades.length]);
    const locked = state.active || !!state.pending || state.trades.length > 0;
    const field = (
        label: string,
        key: keyof Pick<
            Settings,
            'stake' | 'maxLosses' | 'maxStake' | 'stopLoss' | 'takeProfit' | 'triggerCount' | 'multiplier'
        >,
        min: number,
        step: number
    ) => (
        <label>
            {label}
            <input
                type='number'
                inputMode={step === 1 ? 'numeric' : 'decimal'}
                min={min}
                step={step}
                value={Number.isNaN(draft[key]) ? '' : draft[key]}
                disabled={locked}
                onChange={event =>
                    setDraft(previous => ({
                        ...previous,
                        [key]: event.target.value === '' ? NaN : Number(event.target.value),
                    }))
                }
            />
        </label>
    );
    const showDashboard = state.active || state.trades.length > 0 || state.markets.length > 0 || !!state.pending;
    const groups = ['DIGITOVER', 'DIGITUNDER', 'DIGITDIFF', 'DIGITEVEN', 'DIGITODD']
        .map(direction => {
            const trades = state.trades.filter(t => t.direction === direction && t.profit !== undefined);
            return {
                direction,
                count: trades.length,
                won: trades.filter(t => t.profit! > 0).length,
                net: trades.reduce((sum, t) => sum + (t.profit || 0), 0),
            };
        })
        .filter(group => group.count);
    return (
        <div className='analysis-tool' ref={panel} tabIndex={0} aria-label='Digit strategy trading dashboard'>
            <header className='analysis-tool__heading'>
                <div>
                    <p className='analysis-tool__eyebrow'>NETOACADEMY STRATEGIES</p>
                    <h1>Digit Strategy</h1>
                    <span className='analysis-tool__account'>
                        {account
                            ? `${account.account_type === 'demo' ? 'Demo' : 'Real'} · ${account.account_id} · ${account.currency}`
                            : 'Not logged in'}
                    </span>
                </div>
                <button className='analysis-tool__terminal-button' onClick={() => setTerminal(true)}>
                    <span aria-hidden='true'>›_</span> Execution terminal
                </button>
            </header>
            {state.settings.strategy === 'over2-under7' && (
                <p className='analysis-tool__hint'>
                    This account’s session belongs to the HIT AND RUN STRATEGY in Digit Analysis. Stop and reset the
                    stopped session before switching strategies.
                </p>
            )}
            {!session.authenticated && (
                <div className='analysis-tool__notice'>
                    Log in with Deriv to run the strategy on your selected USD account.
                    <button onClick={startDerivLogin}>Log in with Deriv</button>
                </div>
            )}
            {state.demoOnly && (
                <p className='analysis-tool__hint'>
                    Server preview · use a USD demo account. Devices sharing that account see the same session.
                </p>
            )}
            <section className='analysis-tool__panel' aria-label='Trading parameters'>
                <div className='analysis-tool__settings'>
                    {field('Starting stake (USD)', 'stake', 0.35, 0.01)}
                    {field('Maximum consecutive losses', 'maxLosses', 1, 1)}
                    {field('Maximum stake per trade (USD)', 'maxStake', 0.35, 0.01)}
                    {field('Session stop-loss (USD)', 'stopLoss', 0.35, 0.01)}
                    {field('Martingale multiplier', 'multiplier', 1, 0.01)}
                </div>
                <details className='analysis-tool__advanced'>
                    <summary>Strategy settings</summary>
                    <div className='analysis-tool__settings'>
                        <label>
                            Recovery policy
                            <select
                                value={draft.recoveryMode}
                                disabled={locked}
                                onChange={event =>
                                    setDraft(previous => ({
                                        ...previous,
                                        recoveryMode: event.target.value as Settings['recoveryMode'],
                                    }))
                                }
                            >
                                {Object.entries(RECOVERY_MODES).map(([value, label]) => (
                                    <option key={value} value={value}>
                                        {label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {!['under5_filtered_once', 'parity_percentage'].includes(draft.recoveryMode) &&
                            field('Recovery trigger count', 'triggerCount', 1, 1)}
                        <label>
                            Contract duration
                            <select
                                value={draft.duration}
                                disabled={locked}
                                onChange={event =>
                                    setDraft(previous => ({ ...previous, duration: Number(event.target.value) }))
                                }
                            >
                                <option value={1}>1 tick</option>
                                <option value={2}>2 ticks</option>
                            </select>
                        </label>
                        {field('Take-profit (USD, 0 = off)', 'takeProfit', 0, 0.01)}
                    </div>
                    <p>
                        Recovery uses your martingale multiplier after a loss, rounded to cents. A win resets the
                        starting stake. Three normal settled trades trigger a five-second pause when recovery is clear.
                    </p>
                </details>
                <div className='analysis-tool__actions'>
                    <button
                        className='analysis-tool__run'
                        onClick={() => void run()}
                        disabled={
                            state.active ||
                            !session.authenticated ||
                            account?.currency !== 'USD' ||
                            (!!state.pending && !state.pending.contractId)
                        }
                    >
                        {state.active ? 'RUNNING' : state.pending?.contractId ? 'RESUME / RECONCILE' : 'RUN'}
                    </button>
                    <button
                        className='analysis-tool__stop'
                        onClick={() => digitStrategyEngine.stop().catch(reason => setError(reason.message))}
                        disabled={!state.active || !state.wantsRun}
                    >
                        STOP
                    </button>
                    <button className='analysis-tool__reset' onClick={reset} disabled={state.active || !!state.pending}>
                        New session
                    </button>
                    <span role='status' className='analysis-tool__phase'>
                        {state.phase}
                    </span>
                </div>
                <p className='analysis-tool__hint'>
                    Runs on the server; connected devices share this session. STOP blocks new purchases and waits for an
                    open contract to settle. Use New session to clear a stopped session and change its parameters.
                </p>
            </section>
            {(error || state.error) && (
                <div role='alert' className='analysis-tool__error'>
                    {error || state.error}
                </div>
            )}
            {state.pending && !state.pending.contractId && (
                <section className='analysis-tool__panel analysis-tool__reconcile'>
                    <h2>Unconfirmed purchase</h2>
                    <p>
                        No new purchases will be made. Find this trade’s contract ID in Deriv history and reconcile it.
                    </p>
                    <label>
                        Contract ID
                        <input
                            type='text'
                            inputMode='numeric'
                            value={contractId}
                            onChange={event => setContractId(event.target.value)}
                        />
                    </label>
                    <button
                        disabled={
                            state.active ||
                            !/^\d+$/.test(contractId) ||
                            !Number.isSafeInteger(Number(contractId)) ||
                            Number(contractId) <= 0
                        }
                        onClick={() => void run(Number(contractId))}
                    >
                        Check contract
                    </button>
                </section>
            )}
            {showDashboard && (
                <>
                    <div className='analysis-tool__stats'>
                        {[
                            ['Session P/L', money(state.pnl)],
                            ['Wins / Losses', `${state.wins} / ${state.losses}`],
                            ['Loss streak', `${state.streak} / ${state.settings.maxLosses}`],
                            ['Next stake', money(state.stake)],
                            ['Largest drawdown', money(state.maxDrawdown)],
                            ['Highest stake', money(state.highestStake)],
                        ].map(([label, value]) => (
                            <div key={label}>
                                <span>{label}</span>
                                <strong
                                    className={
                                        label === 'Session P/L' ? (state.pnl < 0 ? 'is-loss' : 'is-profit') : undefined
                                    }
                                >
                                    {value}
                                </strong>
                            </div>
                        ))}
                    </div>
                    <div className='analysis-tool__two-column'>
                        <section className='analysis-tool__panel'>
                            <h2>Recovery</h2>
                            <div className='analysis-tool__recovery-value'>
                                {state.streak ? 'Recovery active' : 'Normal entries'}
                            </div>
                            <p>
                                {state.settings.strategy === 'over2-under7' && state.settings.hitRecovery !== 'analysis'
                                    ? 'Custom recovery'
                                    : RECOVERY_MODES[state.settings.recoveryMode]}
                            </p>
                            <p>
                                {state.recovery.lockedSymbol
                                    ? `Locked index: ${state.recovery.lockedSymbol}`
                                    : 'Scanning eligible indices'}
                            </p>
                        </section>
                        <section className='analysis-tool__panel'>
                            <h2>Latest quote</h2>
                            {state.quote ? (
                                <div className='analysis-tool__quote'>
                                    <span>
                                        Stake<strong>{money(state.quote.stake)}</strong>
                                    </span>
                                    <span>
                                        Payout<strong>{money(state.quote.payout)}</strong>
                                    </span>
                                    <span>
                                        Break-even<strong>{state.quote.breakEven.toFixed(2)}%</strong>
                                    </span>
                                </div>
                            ) : (
                                <p>Waiting for an eligible entry</p>
                            )}
                            <p>
                                {state.selected
                                    ? `${state.selected.symbol} · ${state.selected.direction} ${state.selected.barrier ?? ''} · ${state.selected.recovery ? 'Recovery' : 'Normal'}`
                                    : 'No selected contract'}
                            </p>
                        </section>
                    </div>
                    <section className='analysis-tool__panel'>
                        <div className='analysis-tool__panel-heading'>
                            <h2>Live digit markets</h2>
                            <input
                                aria-label='Filter markets'
                                placeholder='Find a market…'
                                value={marketFilter}
                                onChange={event => setMarketFilter(event.target.value)}
                            />
                        </div>
                        <div className='analysis-tool__markets'>
                            {state.markets
                                .filter(m => `${m.name} ${m.symbol}`.toLowerCase().includes(marketFilter.toLowerCase()))
                                .map(m => (
                                    <article className='analysis-tool__market' key={m.symbol}>
                                        <header>
                                            <h3>{m.name}</h3>
                                            <span className={m.ready ? 'is-profit' : undefined}>{m.status}</span>
                                        </header>
                                        <div className='analysis-tool__market-price'>
                                            <strong>{m.price}</strong>
                                            <span>{m.count}/1,000 ticks</span>
                                        </div>
                                        <p>
                                            Even{' '}
                                            {m.digits
                                                .filter(d => d.digit % 2 === 0)
                                                .reduce((total, d) => total + d.percentage, 0)
                                                .toFixed(1)}
                                            %{' · '}Odd{' '}
                                            {m.digits
                                                .filter(d => d.digit % 2 !== 0)
                                                .reduce((total, d) => total + d.percentage, 0)
                                                .toFixed(1)}
                                            %
                                        </p>
                                        <div className='analysis-tool__digits'>
                                            {m.digits.map(d => (
                                                <div
                                                    key={d.digit}
                                                    className={`${d.most ? 'most ' : ''}${d.least ? 'least ' : ''}${m.latest === d.digit ? 'latest' : ''}`}
                                                >
                                                    <strong>{d.digit}</strong>
                                                    <span>{d.percentage.toFixed(1)}%</span>
                                                </div>
                                            ))}
                                        </div>
                                    </article>
                                ))}
                            {!state.markets.length && <p>Discovering supported volatility markets…</p>}
                        </div>
                        <p className='analysis-tool__hint'>
                            Green: most frequent · red: least frequent · outlined: latest digit. Percentages describe
                            past ticks, not the probability of the next digit.
                        </p>
                    </section>
                    <section className='analysis-tool__panel'>
                        <h2>Trade journal</h2>
                        <div
                            className='analysis-tool__table'
                            tabIndex={0}
                            aria-label='Trade journal, scroll horizontally for all columns'
                        >
                            <table>
                                <thead>
                                    <tr>
                                        {[
                                            'Time',
                                            'Contract',
                                            'Market',
                                            'Type',
                                            'Stake',
                                            'Entry',
                                            'Exit',
                                            'Result',
                                            'Net',
                                        ].map(label => (
                                            <th key={label}>{label}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...state.trades].reverse().map(t => (
                                        <tr key={t.id}>
                                            <td>{time(t.at)}</td>
                                            <td>{t.contractId ?? 'Confirming…'}</td>
                                            <td>{t.market}</td>
                                            <td>
                                                {t.direction} {t.barrier ?? ''}
                                                {t.recovery && <small>Recovery</small>}
                                            </td>
                                            <td>{money(t.stake)}</td>
                                            <td>{t.entry ?? 'Pending'}</td>
                                            <td>{t.exit ?? 'Pending'}</td>
                                            <td>{t.status}</td>
                                            <td className={(t.profit || 0) < 0 ? 'is-loss' : 'is-profit'}>
                                                {t.profit === undefined ? '—' : money(t.profit)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {!state.trades.length && <p>No purchases yet.</p>}
                        </div>
                    </section>
                    {groups.length > 0 && (
                        <section className='analysis-tool__panel'>
                            <h2>Settled results · latest 100 trades</h2>
                            <div className='analysis-tool__table'>
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Contract type</th>
                                            <th>Trades</th>
                                            <th>Win rate</th>
                                            <th>Net</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {groups.map(g => (
                                            <tr key={g.direction}>
                                                <td>{g.direction}</td>
                                                <td>{g.count}</td>
                                                <td>{((100 * g.won) / g.count).toFixed(1)}%</td>
                                                <td>{money(g.net)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </section>
                    )}
                </>
            )}
            <dialog
                className='strategy-terminal'
                ref={dialog}
                onCancel={() => setTerminal(false)}
                onClick={event => {
                    if (event.target === dialog.current) setTerminal(false);
                }}
            >
                <div className='strategy-terminal__header'>
                    <strong>›_ Execution terminal</strong>
                    <button onClick={() => setTerminal(false)} aria-label='Close execution terminal'>
                        Close ✕
                    </button>
                </div>
                <div
                    className='strategy-terminal__output'
                    ref={output}
                    role='log'
                    aria-live='polite'
                    aria-label='Strategy execution log'
                >
                    {state.logs.length ? (
                        state.logs.map((log, index) => (
                            <div key={`${log.at}-${index}`} className={`strategy-terminal__line--${log.level}`}>
                                <time>{time(log.at)}</time>
                                <span>{log.message}</span>
                            </div>
                        ))
                    ) : (
                        <p>Ready. Execution messages will appear here after RUN.</p>
                    )}
                </div>
            </dialog>
        </div>
    );
}
