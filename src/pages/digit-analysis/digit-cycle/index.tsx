import { useEffect, useState, useSyncExternalStore } from 'react';
import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { cycleDirections, DEFAULT_SETTINGS, RECOVERY_MODES, type Settings } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import './digit-cycle.scss';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const defaults = (): Settings => ({ ...DEFAULT_SETTINGS, strategy: 'over2-under7', hitRecovery: 'analysis' });
export default function DigitCycle() {
    const state = useSyncExternalStore(digitStrategyEngine.subscribe, digitStrategyEngine.getSnapshot);
    const [draft, setDraft] = useState(defaults);
    const [error, setError] = useState('');
    const [contractId, setContractId] = useState('');
    const [session, setSession] = useState(getDerivSession());
    const own = state.settings.strategy === 'over2-under7';
    const policyRecovery = own && state.streak > 0 && state.settings.hitRecovery === 'analysis';
    const busy = state.active || !!state.pending;
    const history = state.trades.length > 0;
    const locked = busy || history;
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
                if (!own && (busy || history))
                    throw new Error('Stop and reset the Analysis Tool session before switching tools.');
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
        <section className='digit-cycle' aria-labelledby='digit-cycle-title'>
            <h2 id='digit-cycle-title'>HIT AND RUN STRATEGY</h2>
            <p>Analysing Under 7 and Over 2 markets.</p>
            <div className='digit-cycle__fields'>
                {field('Starting stake (USD)', 'stake', 0.35)}
                {field('Martingale multiplier', 'multiplier', 1)}
                <label>
                    Recovery method
                    <select
                        value={draft.hitRecovery || 'same_contract'}
                        disabled={locked}
                        onChange={event =>
                            setDraft(previous => ({
                                ...previous,
                                hitRecovery: event.target.value as Settings['hitRecovery'],
                            }))
                        }
                    >
                        <option value='analysis'>Analysis Tool recovery policy</option>
                        <option value='same_contract'>Same contract · martingale</option>
                    </select>
                </label>
                {draft.hitRecovery === 'analysis' && (
                    <>
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
                        {field('High-digit formation count', 'triggerCount', 1, 1)}
                    </>
                )}

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
                        <option value={1}>1 tick</option>
                        <option value={2}>2 ticks</option>
                    </select>
                </label>
            </div>
            {!own && (busy || history) && <p>Existing Analysis Tool session.</p>}
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
                        <span>Session P/L: {money(state.pnl)}</span>
                        <span>
                            Wins / Losses: {state.wins} / {state.losses}
                        </span>
                        <span>
                            Loss streak: {state.streak} / {state.settings.maxLosses}
                        </span>
                        <span>Next stake: {money(state.stake)}</span>
                        <span>
                            Batch wins: {state.batch} / 3{state.streak ? ' · Recovery active' : ''}
                        </span>
                    </div>
                    <div className='digit-cycle__markets'>
                        {state.markets
                            .filter(
                                market => !state.recovery.lockedSymbol || market.symbol === state.recovery.lockedSymbol
                            )
                            .map(market => {
                                const candidates =
                                    !policyRecovery && market.ready && !state.recovery.lockedSymbol
                                        ? cycleDirections(market.digits, market.latest)
                                        : [];
                                return (
                                    <article key={market.symbol}>
                                        <h3>{market.name}</h3>
                                        <p>
                                            {market.status} · Last digit: {market.latest ?? '—'} ·{' '}
                                            {policyRecovery
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
                        <div className='digit-cycle__table'>
                            <table>
                                <caption>Recent trades</caption>
                                <thead>
                                    <tr>
                                        <th>Market</th>
                                        <th>Contract</th>
                                        <th>Stake</th>
                                        <th>Entry</th>
                                        <th>Exit</th>
                                        <th>Result</th>
                                        <th>Net</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {state.trades.slice(0, 20).map(trade => (
                                        <tr key={trade.id}>
                                            <td>{trade.market}</td>
                                            <td>
                                                {trade.direction} {trade.barrier}
                                                {trade.recovery ? ' · Recovery' : ''}
                                            </td>
                                            <td>{money(trade.stake)}</td>
                                            <td>{trade.entry || '—'}</td>
                                            <td>{trade.exit || '—'}</td>
                                            <td>{trade.status}</td>
                                            <td>{trade.profit === undefined ? '—' : money(trade.profit)}</td>
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
