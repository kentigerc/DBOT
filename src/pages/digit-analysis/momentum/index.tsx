import { useEffect, useState, useSyncExternalStore } from 'react';
import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { DEFAULT_SETTINGS, type Settings } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import './momentum.scss';
const defaults = (): Settings => ({
    ...DEFAULT_SETTINGS,
    strategy: 'momentum-70',
    recoveryMode: 'same_contract',
    hitRecovery: 'same_contract',
    multiplier: 2,
});
const money = (amount: number) => `$${(amount / 100).toFixed(2)}`;
export default function Momentum() {
    const state = useSyncExternalStore(digitStrategyEngine.subscribe, digitStrategyEngine.getSnapshot);
    const own = state.settings.strategy === 'momentum-70';
    const [draft, setDraft] = useState(defaults);
    const [session, setSession] = useState(getDerivSession());
    const [error, setError] = useState('');
    const [reconcile, setReconcile] = useState('');
    const busy = state.active || !!state.pending,
        locked = busy || state.trades.length > 0;
    useEffect(() => {
        const update = () => {
            setSession(getDerivSession());
            digitStrategyEngine.selectAccount(getDerivAccount());
        };
        update();
        window.addEventListener('neto-session', update);
        return () => window.removeEventListener('neto-session', update);
    }, []);
    useEffect(() => {
        if (own && locked) setDraft({ ...state.settings });
    }, [own, locked, state.settings]);
    const command = async (action: 'run' | 'stop' | 'reset') => {
        setError('');
        try {
            if (action === 'stop') await digitStrategyEngine.stop();
            else if (action === 'reset') {
                await digitStrategyEngine.reset();
                setDraft(defaults());
            } else {
                if (!own && locked) throw new Error('Stop and reset the current tool before switching strategies.');
                await digitStrategyEngine.start(
                    own && locked ? state.settings : draft,
                    own && state.pending && !state.pending.contractId ? Number(reconcile) || undefined : undefined
                );
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Unable to update session.');
        }
    };
    const field = (
        label: string,
        key: 'stake' | 'multiplier' | 'maxLosses' | 'maxStake' | 'stopLoss' | 'takeProfit',
        min: number,
        step = 0.01
    ) => (
        <label>
            {label}
            <input
                type='number'
                min={min}
                step={step}
                inputMode={step === 1 ? 'numeric' : 'decimal'}
                disabled={locked}
                value={Number.isNaN(draft[key]) ? '' : draft[key]}
                onChange={e =>
                    setDraft(previous => ({ ...previous, [key]: e.target.value === '' ? NaN : Number(e.target.value) }))
                }
            />
        </label>
    );
    const markets = own ? state.markets : [];
    const focus =
        markets.find(m => m.symbol === state.recovery.lockedSymbol) ||
        markets.find(m => m.symbol === state.selected?.symbol) ||
        markets[0];
    const trades = own ? [...state.trades].reverse() : [];
    return (
        <section className='momentum' aria-labelledby='momentum-title'>
            <header className='momentum__heading'>
                <div>
                    <span className='momentum__eyebrow'>LIVE MARKET DESK</span>
                    <h2 id='momentum-title'>
                        Momentum <span>70</span>
                    </h2>
                    <p>Over 2 & Under 7 · Three-win batches · Same-contract recovery</p>
                </div>
                <span className={`momentum__status${own && state.active ? ' is-live' : ''}`}>
                    {own && state.active ? 'LIVE SESSION' : 'READY WHEN YOU ARE'}
                </span>
            </header>
            <div className='momentum__body'>
                <aside className='momentum__controls' aria-label='Momentum 70 controls'>
                    <h3>Your session</h3>
                    {field('Starting stake (USD)', 'stake', 0.35)}
                    {field('Martingale multiplier', 'multiplier', 1)}
                    {field('Maximum consecutive losses', 'maxLosses', 1, 1)}
                    {field('Maximum stake (USD)', 'maxStake', 0.35)}
                    {field('Stop-loss (USD)', 'stopLoss', 0.35)}
                    {field('Take-profit (USD, 0 = off)', 'takeProfit', 0)}
                    <label>
                        Duration
                        <select
                            disabled={locked}
                            value={draft.duration}
                            onChange={e => setDraft(previous => ({ ...previous, duration: Number(e.target.value) }))}
                        >
                            {[1, 2, 3, 4, 5].map(n => (
                                <option key={n} value={n}>
                                    {n} {n === 1 ? 'tick' : 'ticks'}
                                </option>
                            ))}
                        </select>
                    </label>
                    <div className='momentum__buttons'>
                        <button
                            disabled={!session.authenticated || (own && state.active) || (!own && locked)}
                            onClick={() => void command('run')}
                        >
                            RUN MOMENTUM
                        </button>
                        <button disabled={!own || !busy} onClick={() => void command('stop')}>
                            STOP
                        </button>
                    </div>
                    <button className='momentum__reset' disabled={!own || busy} onClick={() => void command('reset')}>
                        Reset stopped session
                    </button>
                    {!session.authenticated && <p>Log in with Deriv to start.</p>}
                    {!own && locked && (
                        <p>Another tool owns this account’s session. Stop and reset it before switching.</p>
                    )}
                    {own && state.pending && !state.pending.contractId && (
                        <label>
                            Unconfirmed contract ID
                            <input inputMode='numeric' value={reconcile} onChange={e => setReconcile(e.target.value)} />
                        </label>
                    )}
                    {error && <p role='alert'>{error}</p>}
                </aside>
                <div className='momentum__desk'>
                    <div className='momentum__ticker' role='status'>
                        <span>{own ? state.phase : 'Waiting to start'}</span>
                        <strong className={own && state.pnl < 0 ? 'is-loss' : ''}>
                            {money(own ? state.pnl : 0)} <small>session net</small>
                        </strong>
                    </div>
                    {own && state.error && <p role='alert'>{state.error}</p>}
                    {own && (state.recovery.deficit || 0) > 0 && (
                        <p className='momentum__balance' role='status'>
                            Recovery balance <strong>{money(state.recovery.deficit || 0)}</strong> · Waiting for the
                            same contract’s next qualifying entry.
                        </p>
                    )}
                    <div className='momentum__steps'>
                        <span>
                            <b>01</b> Live market scan
                        </span>
                        <span>
                            <b>02</b> Rising share
                        </span>
                        <span>
                            <b>03</b> Entry formation
                        </span>
                        <span>
                            <b>04</b> Trade batch
                        </span>
                    </div>
                    <div className='momentum__signals'>
                        {(['DIGITOVER', 'DIGITUNDER'] as const).map(direction => {
                            const reading = focus?.momentum?.[direction];
                            const percent = reading?.percentage || 0,
                                change = reading?.change || 0;
                            return (
                                <article
                                    key={direction}
                                    className={`momentum__signal ${direction === 'DIGITOVER' ? 'is-over' : 'is-under'}`}
                                >
                                    <span>{direction === 'DIGITOVER' ? 'OVER 2' : 'UNDER 7'}</span>
                                    <strong>
                                        {percent.toFixed(1)}
                                        <small>%</small>
                                    </strong>
                                    <div
                                        className='momentum__meter'
                                        role='meter'
                                        aria-label={`${direction === 'DIGITOVER' ? 'Over 2' : 'Under 7'} cumulative percentage`}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={percent}
                                    >
                                        <i style={{ width: `${Math.min(100, percent)}%` }} />
                                    </div>
                                    <footer>
                                        <span>
                                            {change > 0 ? '↑' : change < 0 ? '↓' : '—'} {Math.abs(change).toFixed(1)} pp
                                        </span>
                                        <span>{reading?.armed ? `${reading.run}/2 observed` : 'Observing market'}</span>
                                    </footer>
                                </article>
                            );
                        })}
                    </div>
                    <div className='momentum__summary'>
                        <span>
                            <b>{own ? state.batch : 0}/3</b> Batch wins
                        </span>
                        <span>
                            <b>{own ? `${state.wins} / ${state.losses}` : '0 / 0'}</b> Wins / Losses
                        </span>
                        <span>
                            <b>{own ? `${state.streak} / ${state.settings.maxLosses}` : `0 / ${draft.maxLosses}`}</b>{' '}
                            Loss streak
                        </span>
                        <span>
                            <b>{own ? money(state.stake) : `$${draft.stake.toFixed(2)}`}</b> Next stake
                        </span>
                    </div>
                    <div className='momentum__markets'>
                        <h3>
                            {focus?.name || 'All supported Volatility markets'}{' '}
                            <small>
                                {own && (state.streak || (state.recovery.deficit || 0) > 0)
                                    ? 'Same-market recovery'
                                    : 'Live watchlist'}
                            </small>
                        </h3>
                        <div className='momentum__table'>
                            <table>
                                <thead>
                                    <tr>
                                        <th>Market</th>
                                        <th>Over 2</th>
                                        <th>Under 7</th>
                                        <th>Feed</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {markets.map(m => (
                                        <tr key={m.symbol} className={m.symbol === focus?.symbol ? 'is-selected' : ''}>
                                            <td>{m.name}</td>
                                            <td>{(m.momentum?.DIGITOVER.percentage || 0).toFixed(1)}%</td>
                                            <td>{(m.momentum?.DIGITUNDER.percentage || 0).toFixed(1)}%</td>
                                            <td>{m.ready ? 'Live' : m.status}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {!markets.length && <p>Market readings appear when the session starts.</p>}
                        </div>
                    </div>
                    <details className='momentum__journal' open>
                        <summary>
                            Trade journal <span>{trades.length} recent trades</span>
                        </summary>
                        <div className='momentum__table'>
                            <table>
                                <thead>
                                    <tr>
                                        <th>Time / Contract</th>
                                        <th>Market / Contract type</th>
                                        <th>Stake</th>
                                        <th>Entry → Exit</th>
                                        <th>Result</th>
                                        <th>Net</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {trades.map(t => (
                                        <tr key={t.id}>
                                            <td>
                                                {new Date(t.at).toLocaleTimeString()}
                                                <small>{t.contractId || 'Pending'}</small>
                                            </td>
                                            <td>
                                                {t.market}
                                                <small>
                                                    {t.direction === 'DIGITOVER' ? 'Over 2' : 'Under 7'}
                                                    {t.recovery ? ' · Recovery' : ''}
                                                </small>
                                            </td>
                                            <td>{money(t.stake)}</td>
                                            <td>
                                                {t.entry ?? '—'} → {t.exit ?? '—'}
                                            </td>
                                            <td>{t.status}</td>
                                            <td
                                                className={
                                                    t.profit === undefined ? '' : t.profit < 0 ? 'is-loss' : 'is-profit'
                                                }
                                            >
                                                {t.profit === undefined ? '—' : money(t.profit)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {!trades.length && <p>No trades in this session.</p>}
                        </div>
                    </details>
                    {own && (
                        <details className='momentum__journal'>
                            <summary>Execution log</summary>
                            <div className='momentum__log'>
                                {state.logs.map((log, i) => (
                                    <p key={i}>
                                        {new Date(log.at).toLocaleTimeString()} · {log.message}
                                    </p>
                                ))}
                            </div>
                        </details>
                    )}
                </div>
            </div>
        </section>
    );
}
