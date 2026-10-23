import { useEffect, useState, useSyncExternalStore } from 'react';
import { digitStrategyEngine } from '@/services/digit-strategy/client';
import { cycleDirections, DEFAULT_SETTINGS, type Settings } from '@/services/digit-strategy/strategy';
import { getDerivAccount, getDerivSession } from '@/utils/deriv-session';
import './digit-cycle.scss';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const defaults = (): Settings => ({ ...DEFAULT_SETTINGS, strategy: 'over2-under7' });
export default function DigitCycle() {
    const state = useSyncExternalStore(digitStrategyEngine.subscribe, digitStrategyEngine.getSnapshot);
    const [draft, setDraft] = useState(defaults);
    const [error, setError] = useState('');
    const [contractId, setContractId] = useState('');
    const [session, setSession] = useState(getDerivSession());
    const own = state.settings.strategy === 'over2-under7';
    const busy = state.active || !!state.pending;
    const history = state.trades.length > 0;
    const locked = busy || history;
    const account = getDerivAccount();
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
            <p>
                Scans both directions across available Volatility markets using 1,000 live ticks. Every entry requires
                fresh matching percentages and the specified last digit.
            </p>
            <p>
                <strong>Over 2:</strong> digits 0, 1, 2 each below 10%, with no red/green frequency marks; enter only
                after digit 1 or 2. <strong>Under 7:</strong> digits 7, 8, 9 each below 10%, with no red/green frequency
                marks; enter only after digit 7 or 8.
            </p>
            <div className='digit-cycle__fields'>
                {field('Starting stake (USD)', 'stake', 0.35)}
                {field('Martingale multiplier', 'multiplier', 1)}
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
            <p>
                Up to three normal trades per sequence on the selected market and direction. Recovery may require
                additional trades. After a loss, wait for another qualifying entry on that market, apply the multiplier,
                and recover until a win or a risk limit. After three runs or a recovery win, pause five seconds, then
                analyse afresh. Recovery wins end the sequence; they do not guarantee that all earlier losses are
                repaid.
            </p>
            <p>
                {account
                    ? `${account.account_type === 'demo' ? 'Demo' : 'Real'} · ${account.account_id} · ${account.currency}`
                    : 'Log in with Deriv to trade.'}
                {state.demoOnly ? ' · Server preview: USD demo accounts only.' : ''}
            </p>
            {!own && (busy || history) && (
                <p>
                    The Analysis Tool has a session on this account. Stop it there and reset the stopped session before
                    switching tools.
                </p>
            )}
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
            <p>
                Uses the same account session as Analysis Tool; only one tool or Bot Builder can trade at a time. Reset
                clears the stopped session’s statistics before changing settings or tools. RUN starts automated trading;
                STOP prevents new entries while an existing contract settles.
            </p>
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
                            Sequence trades: {state.batch}
                            {state.streak ? ' · Recovery active' : ''}
                        </span>
                    </div>
                    <div className='digit-cycle__markets'>
                        {state.markets.map(market => {
                            const candidates = market.ready ? cycleDirections(market.digits, market.latest) : [];
                            return (
                                <article key={market.symbol}>
                                    <h3>{market.name}</h3>
                                    <p>
                                        {market.status} · Last digit: {market.latest ?? '—'} ·{' '}
                                        {candidates.length
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
            <p>
                Past digit frequencies do not predict the next tick. Martingale increases exposure and can reach your
                risk limits.
            </p>
        </section>
    );
}
