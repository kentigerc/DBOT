import { useEffect, useState, useSyncExternalStore } from 'react';
import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { cycleDirections, DEFAULT_SETTINGS, RECOVERY_MODES, type Settings } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import './digit-cycle.scss';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const defaults = (parity = false): Settings => ({
    ...DEFAULT_SETTINGS,
    ...(parity ? { multiplier: 2, duration: 1 } : { duration: 2 }),
    strategy: parity ? 'even-odd' : 'over2-under7',
    hitRecovery: 'analysis',
});
export default function DigitCycle({ parity = false }: { parity?: boolean }) {
    const strategy = parity ? 'even-odd' : 'over2-under7';
    const titleId = parity ? 'even-odd-title' : 'digit-cycle-title';
    const state = useSyncExternalStore(digitStrategyEngine.subscribe, digitStrategyEngine.getSnapshot);
    const [draft, setDraft] = useState(() => defaults(parity));
    const [error, setError] = useState('');
    const [contractId, setContractId] = useState('');
    const [session, setSession] = useState(getDerivSession());
    const [previewIndex, setPreviewIndex] = useState(0);
    const own = state.settings.strategy === strategy;
    const parityRecovery =
        own && parity && (state.recovery.momentumPending ?? (state.streak > 0 || (state.recovery.deficit || 0) > 0));
    const policyRecovery =
        own && (state.streak > 0 || (state.recovery.deficit || 0) > 0) && state.settings.hitRecovery === 'analysis';
    const busy = state.active || !!state.pending;
    const history = state.trades.length > 0;
    const locked = busy || history;
    useEffect(() => {
        if (!parity || !own || !state.active) return;
        const timer = window.setInterval(() => setPreviewIndex(index => index + 1), 2000);
        return () => window.clearInterval(timer);
    }, [parity, own, state.active]);
    const marketPool = state.markets.filter(
        market =>
            (parity && parityRecovery && !state.recovery.recoveryLocked) ||
            !state.recovery.lockedSymbol ||
            market.symbol === state.recovery.lockedSymbol
    );
    const readyPreviews = marketPool.filter(market => market.ready);
    const pinnedSymbol =
        parityRecovery && state.recovery.recoveryLocked ? state.recovery.lockedSymbol : state.pending?.signal.symbol;
    const focus = pinnedSymbol
        ? marketPool.find(market => market.symbol === pinnedSymbol)
        : readyPreviews.length
          ? readyPreviews[previewIndex % readyPreviews.length]
          : marketPool[0];
    const visibleMarkets = parity ? (focus ? [focus] : []) : marketPool;

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
                setDraft(defaults(parity));
            } else {
                if (!own && (busy || history))
                    throw new Error('Stop and reset the existing strategy session before switching tools.');
                await digitStrategyEngine.start(
                    own && locked ? state.settings : draft,
                    own && state.pending && !state.pending.contractId ? Number(contractId) || undefined : undefined
                );
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Unable to update trading session.');
        }
    };
    const field = (
        label: string,
        key: 'stake' | 'multiplier' | 'maxLosses' | 'maxStake' | 'stopLoss' | 'takeProfit' | 'triggerCount',
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
    return (
        <section className={`digit-cycle${parity ? ' digit-cycle--parity' : ''}`} aria-labelledby={titleId}>
            {parity ? (
                <header className='digit-cycle__parity-header'>
                    <div>
                        <span className='digit-cycle__eyebrow'>PARITY WORKSPACE</span>
                        <h2 id={titleId}>EVEN / ODD STRATEGY</h2>
                        <p>
                            Trading Even and Odd · {draft.duration} {draft.duration === 1 ? 'tick' : 'ticks'}.
                        </p>
                    </div>
                    <div className='digit-cycle__parity-mark' aria-hidden='true'>
                        <span>
                            E<small>EVEN</small>
                        </span>
                        <span>
                            O<small>ODD</small>
                        </span>
                    </div>
                </header>
            ) : (
                <>
                    <h2 id={titleId}>HIT AND RUN STRATEGY</h2>
                    <p>Trading Under 7 and Over 2 · Even/Odd recovery.</p>
                </>
            )}
            {parity && (
                <div className='digit-cycle__setup-heading'>
                    <h3>Your trading setup</h3>
                    <span>Stake, duration &amp; session limits</span>
                </div>
            )}

            <div className='digit-cycle__fields'>
                {field('Starting stake (USD)', 'stake', 0.35)}
                {field('Martingale multiplier', 'multiplier', 1)}
                {draft.hitRecovery === 'analysis' &&
                    !['under5_filtered_once', 'parity_percentage'].includes(draft.recoveryMode) &&
                    field('Recovery trigger count', 'triggerCount', 1, 1)}
                {field('Maximum consecutive losses', 'maxLosses', 1, 1)}
                {field('Maximum stake per trade (USD)', 'maxStake', 0.35)}
                {field('Session stop-loss (USD)', 'stopLoss', 0.35)}
                {field('Take-profit (USD, 0 = off)', 'takeProfit', 0)}
                <label>
                    Contract duration
                    <select
                        value={draft.duration}
                        disabled={locked}
                        onChange={event =>
                            setDraft(previous => ({ ...previous, duration: Number(event.target.value) }))
                        }
                    >
                        {Array.from({ length: parity ? 5 : 2 }, (_, i) => i + 1).map(ticks => (
                            <option key={ticks} value={ticks}>
                                {ticks} {ticks === 1 ? 'tick' : 'ticks'}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {!own && (busy || history) && <p>Another strategy owns the current session.</p>}
            {own && state.pending && !state.pending.contractId && (
                <label>
                    Unconfirmed contract ID from Deriv history
                    <input
                        inputMode='numeric'
                        value={contractId}
                        onChange={event => setContractId(event.target.value)}
                    />
                </label>
            )}
            <div className='digit-cycle__actions'>
                <button
                    disabled={!session.authenticated || state.active || (!own && (busy || history))}
                    onClick={() => void command('run')}
                >
                    {own && state.pending ? 'RECONCILE' : 'RUN'}
                </button>
                <button disabled={!own || !busy} onClick={() => void command('stop')}>
                    STOP
                </button>
                <button disabled={busy} onClick={() => void command('reset')}>
                    Reset stopped session
                </button>
            </div>
            {error && <p role='alert'>{error}</p>}
            {own && (
                <>
                    <p role='status'>
                        {state.phase}
                        {state.error ? ` · ${state.error}` : ''}
                    </p>
                    <div className='digit-cycle__stats'>
                        {[
                            ['Session P/L', money(state.pnl)],
                            ['Wins / Losses', `${state.wins} / ${state.losses}`],
                            ['Loss streak', `${state.streak} / ${state.settings.maxLosses}`],
                            ['Next stake', money(state.stake)],
                            ...(parity
                                ? [['Recovery status', parityRecovery ? 'Active' : 'Ready']]
                                : [['Batch wins', `${state.batch} / 3`]]),
                        ].map(([label, value]) => (
                            <div
                                key={label}
                                className={
                                    label === 'Session P/L' && state.pnl < 0 ? 'digit-cycle__stat--loss' : undefined
                                }
                            >
                                <span>{label}</span>
                                <strong
                                    className={
                                        label === 'Session P/L'
                                            ? state.pnl < 0
                                                ? 'is-loss'
                                                : state.pnl > 0
                                                  ? 'is-profit'
                                                  : undefined
                                            : undefined
                                    }
                                >
                                    {value}
                                </strong>
                                {label === 'Batch wins' && state.streak > 0 && <small>Recovery active</small>}
                            </div>
                        ))}
                    </div>
                    {parity && (
                        <p className='digit-cycle__scan-status' role='status'>
                            {pinnedSymbol
                                ? `${parityRecovery ? 'Recovery locked' : 'Monitoring open contract'} · ${focus?.name || pinnedSymbol}`
                                : state.active
                                  ? `Scanning all markets · ${state.markets.filter(market => market.ready).length}/${state.markets.length} live · Preview rotates every 2 seconds`
                                  : `${state.markets.length} markets in this session · Showing the last readings`}
                        </p>
                    )}
                    <div className='digit-cycle__markets'>
                        {parity && !focus && (
                            <p className='digit-cycle__market-empty'>Live market readings appear when available.</p>
                        )}

                        {visibleMarkets.map(market => {
                            const candidates =
                                !parity && !policyRecovery && market.ready && !state.recovery.lockedSymbol
                                    ? cycleDirections(market.digits, market.latest)
                                    : [];
                            const evenShare = market.digits
                                .filter(d => d.digit % 2 === 0)
                                .reduce((sum, d) => sum + d.percentage, 0);
                            const oddShare = market.digits
                                .filter(d => d.digit % 2 !== 0)
                                .reduce((sum, d) => sum + d.percentage, 0);
                            return (
                                <article key={market.symbol}>
                                    <h3>{market.name}</h3>
                                    <p>
                                        {parity && !state.active ? 'Snapshot' : market.status} · Last digit:{' '}
                                        {market.latest ?? '—'} ·{' '}
                                        {parity
                                            ? parityRecovery
                                                ? state.recovery.recoveryLocked
                                                    ? `Recovering · ${state.recovery.lockedDirection === 'DIGITOVER' ? 'Over 3' : 'Under 6'}`
                                                    : 'Searching recovery entries'
                                                : 'Monitoring Even/Odd'
                                            : policyRecovery
                                              ? `Recovery · ${RECOVERY_MODES[state.settings.recoveryMode]}`
                                              : state.recovery.lockedSymbol === market.symbol
                                                ? `${state.streak ? 'Recovering' : 'Trading batch'} · ${state.recovery.lockedDirection === 'DIGITOVER' ? 'Over 2' : 'Under 7'}`
                                                : candidates.length
                                                  ? candidates
                                                        .map(direction =>
                                                            direction === 'DIGITOVER'
                                                                ? 'Over 2 entry ready'
                                                                : 'Under 7 entry ready'
                                                        )
                                                        .join(', ')
                                                  : 'Waiting for entry conditions'}
                                    </p>
                                    <p>
                                        Even{' '}
                                        {market.digits
                                            .filter(d => d.digit % 2 === 0)
                                            .reduce((total, d) => total + d.percentage, 0)
                                            .toFixed(1)}
                                        %{' · '}Odd{' '}
                                        {market.digits
                                            .filter(d => d.digit % 2 !== 0)
                                            .reduce((total, d) => total + d.percentage, 0)
                                            .toFixed(1)}
                                        %
                                    </p>
                                    {parity && (
                                        <div className='digit-cycle__parity-meter' aria-hidden='true'>
                                            <span style={{ width: `${evenShare}%` }} />
                                            <span style={{ width: `${oddShare}%` }} />
                                        </div>
                                    )}
                                    <div className='digit-cycle__circles'>
                                        {market.digits.map(digit => (
                                            <span
                                                key={digit.digit}
                                                className={digit.most ? 'is-most' : digit.least ? 'is-least' : ''}
                                            >
                                                <strong>{digit.digit}</strong>
                                                {digit.percentage.toFixed(1)}%
                                            </span>
                                        ))}
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                    {state.trades.length > 0 && (
                        <div
                            className='digit-cycle__table'
                            tabIndex={0}
                            aria-label='Trade journal, scroll horizontally for all columns'
                        >
                            <table>
                                <caption>Trade journal</caption>
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Contract</th>
                                        <th>Market</th>
                                        <th>Type</th>
                                        <th>Stake</th>
                                        <th>Entry</th>
                                        <th>Exit</th>
                                        <th>Result</th>
                                        <th>Net</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...state.trades].reverse().map(trade => (
                                        <tr key={trade.id}>
                                            <td>{new Date(trade.at).toLocaleTimeString()}</td>
                                            <td>{trade.contractId ?? 'Confirming…'}</td>
                                            <td>{trade.market}</td>
                                            <td>
                                                {trade.direction} {trade.barrier}
                                                {trade.recovery && <small>Recovery</small>}
                                            </td>
                                            <td>{money(trade.stake)}</td>
                                            <td>{trade.entry ?? 'Pending'}</td>
                                            <td>{trade.exit ?? 'Pending'}</td>
                                            <td>{trade.status}</td>
                                            <td
                                                className={
                                                    trade.profit === undefined || trade.profit === 0
                                                        ? undefined
                                                        : trade.profit < 0
                                                          ? 'is-loss'
                                                          : 'is-profit'
                                                }
                                            >
                                                {trade.profit === undefined ? '—' : money(trade.profit)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <details>
                        <summary>Execution log</summary>
                        <pre>
                            {state.logs
                                .slice(-40)
                                .map(log => `${new Date(log.at).toLocaleTimeString()} ${log.message}`)
                                .join('\n')}
                        </pre>
                    </details>
                </>
            )}
        </section>
    );
}
