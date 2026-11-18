import { exportPairXml } from './xml';
import { useEffect, useRef, useState } from 'react';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { getDerivAccount, sessionRequest } from '@/utils/deriv-session';
import { PAIR_DEFAULTS, parsePairXml, type PairSettings } from './xml';
import './higher-lower.scss';

type Leg = { type: string; id?: number; status: string; profit?: number };
type State = {
    accountId: string;
    source: string;
    active: boolean;
    starting?: boolean;
    busy?: boolean;
    settings: PairSettings;
    pnl: number;
    pairs: number;
    marketCount?: number;
    message: string;
    pending?: { symbol: string; cost: number; minimumWinningNet: number; legs: Leg[] };
    history: { symbol: string; at: number; profit: number; legs: Leg[] }[];
};
export default function HigherLower({
    active = true,
    source = 'analysis',
}: {
    active?: boolean;
    source?: 'analysis' | 'xml';
}) {
    const panel = useMarketPanelHeight<HTMLElement>({ enabled: active });
    const [account, setAccount] = useState(getDerivAccount());
    const [draft, setDraft] = useState<PairSettings>({ ...PAIR_DEFAULTS });
    const [state, setState] = useState<State>();
    const [error, setError] = useState('');
    const [commandPending, setCommandPending] = useState(false);
    const [xmlReady, setXmlReady] = useState(source !== 'xml');
    const generation = useRef(0);
    const commandVersion = useRef(0);
    const nextPollAt = useRef(0);
    const edited = useRef(false);
    const hydrated = useRef(false);
    const busy = !!(state?.active || state?.starting || state?.pending || state?.busy || commandPending);
    useEffect(() => {
        const update = () => setAccount(getDerivAccount());
        window.addEventListener('neto-session', update);
        return () => window.removeEventListener('neto-session', update);
    }, []);
    useEffect(() => {
        generation.current++;
        commandVersion.current++;
        nextPollAt.current = 0;
        edited.current = false;
        hydrated.current = false;
        setCommandPending(false);
        setState(undefined);
        setDraft({ ...PAIR_DEFAULTS });
        setError('');
    }, [account?.account_id, source]);
    useEffect(() => {
        if (source !== 'xml' || !active || !account || xmlReady) return;
        const controller = new AbortController();
        void fetch('/api/bots/load?file=higher-lower-pair.xml', {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
        })
            .then(async r => {
                if (!r.ok) throw new Error('Unable to load the XML bot. Log in and try again.');
                const settings = parsePairXml(await r.text());
                if (!controller.signal.aborted) {
                    setDraft(settings);
                    setXmlReady(true);
                }
            })
            .catch(e => {
                if (!controller.signal.aborted) setError(e.message);
            });
        return () => controller.abort();
    }, [source, active, account?.account_id, xmlReady]);
    useEffect(() => {
        if (!account || (!active && !state?.active && !state?.pending)) return;
        let cancelled = false,
            inFlight = false;
        const id = account.account_id;
        const poll = async () => {
            if (inFlight || Date.now() < nextPollAt.current) return;
            inFlight = true;
            const sequence = generation.current;
            try {
                const value = await sessionRequest(
                    `/api/higher-lower?account_id=${encodeURIComponent(id)}&source=${source}`
                );
                if (!cancelled && sequence === generation.current) {
                    setState(value);
                    if (!hydrated.current) {
                        if (source === 'analysis' && !edited.current && value.settings) setDraft({ ...value.settings });
                        hydrated.current = true;
                    }
                    setError('');
                }
            } catch (e) {
                if (!cancelled && sequence === generation.current) {
                    const failure = e as Error & { status?: number; retryAfter?: number };
                    if (failure.status === 429) nextPollAt.current = Date.now() + (failure.retryAfter || 30) * 1000;
                    setError(failure.message);
                }
            } finally {
                inFlight = false;
            }
        };
        void poll();
        const timer = window.setInterval(poll, 2000);
        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, [account?.account_id, source, active, !!state?.active, !!state?.pending]);
    const command = async (name: 'start' | 'stop' | 'refresh') => {
        if (!account) return;
        const id = account.account_id,
            sequence = ++generation.current;
        const commandId = ++commandVersion.current;
        setCommandPending(true);
        setError('');
        try {
            const value = await sessionRequest(
                `/api/higher-lower?account_id=${encodeURIComponent(id)}&source=${source}`,
                { command: name, ...(name === 'start' ? { settings: draft } : {}) }
            );
            if (sequence === generation.current && getDerivAccount()?.account_id === id) {
                generation.current++;
                setState(value);
            }
        } catch (e) {
            if (sequence === generation.current) setError((e as Error).message);
        } finally {
            if (commandId === commandVersion.current) setCommandPending(false);
        }
    };
    const displayed = state && (state.active || state.starting || state.pending) ? state.settings : draft;
    return (
        <section
            className='higher-lower'
            ref={panel}
            aria-label={source === 'xml' ? 'Higher Lower XML bot' : 'Higher Lower analysis tool'}
        >
            <h1>{source === 'xml' ? 'Higher / Lower XML Bot' : 'Higher / Lower Analysis'}</h1>
            <p>USD demo accounts only. Higher +1 and Lower −1 · paired orders · fixed stake per side.</p>
            {source === 'xml' && (
                <p>
                    This standalone XML bot uses NetoAcademy’s paired-order runtime. Standard Deriv Bot does not support
                    this block. Importing or loading XML never starts trading.
                </p>
            )}
            <p>
                Scans live Volatility prices for volatility expansion. Both fresh quotes must support the duration, and
                either winning payout must cover the combined stakes.
            </p>
            <p className='higher-lower__warning'>
                Both trades can lose between the barriers. Purchases are separate, with no guaranteed simultaneous entry
                or profit. An uncertain or partial pair stops further entries.
            </p>
            <div className='higher-lower__fields'>
                {(
                    [
                        ['stake', 'Stake per side (USD)', 0.35, 0.01],
                        ['duration', 'Duration (ticks)', 5, 1],
                        ['stopLoss', 'Session stop loss (USD)', 0.7, 0.01],
                        ['takeProfit', 'Session take profit (USD)', 0.01, 0.01],
                        ['maxPairs', 'Maximum pairs', 1, 1],
                    ] as const
                ).map(([key, label, min, step]) => (
                    <label key={key}>
                        {label}
                        <input
                            type='number'
                            min={min}
                            step={step}
                            max={key === 'duration' ? 10 : key === 'maxPairs' ? 100 : undefined}
                            disabled={busy || (source === 'xml' && !xmlReady)}
                            value={displayed[key]}
                            onChange={e => {
                                edited.current = true;
                                setDraft(d => ({ ...d, [key]: Number(e.target.value) }));
                            }}
                        />
                    </label>
                ))}
            </div>
            <p>Combined starting stake: ${(displayed.stake * 2).toFixed(2)}. No martingale.</p>
            <div className='higher-lower__actions'>
                <button
                    disabled={busy || !xmlReady || account?.account_type !== 'demo' || account?.currency !== 'USD'}
                    onClick={() => void command('start')}
                >
                    RUN {source === 'xml' ? 'XML BOT' : 'HIGHER / LOWER'}
                </button>
                <button disabled={!state?.active && !state?.starting} onClick={() => void command('stop')}>
                    STOP
                </button>
                <button
                    disabled={!state?.pending || state?.active || commandPending}
                    onClick={() => void command('refresh')}
                >
                    Refresh contract status
                </button>
                {source === 'xml' && (
                    <button
                        disabled={!xmlReady}
                        onClick={() => {
                            const a = document.createElement('a');
                            let text: string;
                            try {
                                text = exportPairXml(displayed);
                            } catch (e) {
                                setError((e as Error).message);
                                return;
                            }
                            const url = URL.createObjectURL(new Blob([text], { type: 'application/xml' }));
                            a.href = url;
                            a.download = 'higher-lower-pair.xml';
                            a.click();
                            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }}
                    >
                        Download XML bot
                    </button>
                )}
            </div>
            {source === 'xml' && (
                <label>
                    Load standalone XML bot
                    <input
                        aria-label='Load standalone XML bot'
                        type='file'
                        accept='.xml,application/xml'
                        disabled={busy}
                        onChange={async event => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            try {
                                if (file.size > 16384) throw new Error('XML bot is too large.');
                                const settings = parsePairXml(await file.text());
                                edited.current = true;
                                setDraft(settings);
                                setXmlReady(true);
                                setError('');
                            } catch (e) {
                                setError((e as Error).message);
                            }
                        }}
                    />
                </label>
            )}
            {account?.account_type !== 'demo' && <p>Select a USD demo account before running this tool.</p>}
            {error && <p role='alert'>{error}</p>}
            <p role='status'>
                {state?.message ||
                    (source === 'xml' && !xmlReady
                        ? 'Load this bot from Free Bots or log in to fetch its XML.'
                        : 'Ready. No trades have been started.')}
            </p>
            {state && (
                <p>
                    Live markets: {state.marketCount || 0} · Completed pairs: {state.pairs} · Session P/L: $
                    {(state.pnl / 100).toFixed(2)}
                </p>
            )}
            {state?.pending && (
                <div>
                    <h2>Pending pair · {state.pending.symbol}</h2>
                    <p>
                        Combined quote cost: ${(state.pending.cost / 100).toFixed(2)} · Quoted net if exactly one leg
                        wins: at least ${(state.pending.minimumWinningNet / 100).toFixed(2)}. Actual execution may
                        differ.
                    </p>
                    {state.pending.legs.map((l, i) => (
                        <p key={i}>
                            {['CALL', 'HIGHER'].includes(l.type) ? 'Higher +1' : 'Lower −1'} · {l.status} · Contract{' '}
                            {l.id || 'unconfirmed'}
                        </p>
                    ))}
                    <p>Unknown purchases are never retried or discarded. Check Reports if an ID is unconfirmed.</p>
                </div>
            )}
            {!!state?.history.length && (
                <table>
                    <caption>This runner’s completed pairs</caption>
                    <thead>
                        <tr>
                            <th>Market</th>
                            <th>Time</th>
                            <th>Net P/L</th>
                        </tr>
                    </thead>
                    <tbody>
                        {state.history.map((p, i) => (
                            <tr key={`${p.at}-${i}`}>
                                <td>{p.symbol}</td>
                                <td>{new Date(p.at).toLocaleTimeString()}</td>
                                <td>${(p.profit / 100).toFixed(2)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
