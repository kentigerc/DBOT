import { useEffect, useState } from 'react';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { digitFrequencies, lastDigit } from './digits';
import { evaluateScan, ScanSide } from './scanner';

type Market = { symbol: string; display_name: string; submarket?: string };
type Api = Awaited<ReturnType<typeof generateDerivApiInstance>>;
type Snapshot = Market & ReturnType<typeof evaluateScan> & { checkedAt: number; digits: number[] };
type Result = Snapshot & { side: ScanSide };

function delay(ms: number, signal: AbortSignal) {
    return new Promise<void>(resolve => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
    });
}

export default function MarketScanner({
    sampleSize,
    onSelect,
    onLoad,
    active = true,
}: {
    sampleSize: number;
    onSelect: (symbol: string) => void;
    onLoad: (side: ScanSide, symbol: string, submarket: string) => boolean;
    active?: boolean;
}) {
    const [enabled, setEnabled] = useState(true);
    const [message, setMessage] = useState('Connecting to market data…');
    const [results, setResults] = useState<Result[]>([]);
    const [preview, setPreview] = useState<Snapshot & { matchedSides: ScanSide[] }>();
    const [loadError, setLoadError] = useState('');
    useEffect(() => {
        setResults([]);
        setPreview(undefined);
        setLoadError('');
    }, [sampleSize]);
    useEffect(() => {
        if (!active || !enabled) {
            setMessage('Scanner paused. Displayed percentages are snapshots.');
            return;
        }
        const controller = new AbortController();
        const { signal } = controller;
        let api: Api | undefined;
        const request = async (payload: Parameters<Api['send']>[0]) => {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let cancel: () => void = () => {};
            try {
                return await Promise.race([
                    api!.send(payload),
                    new Promise<never>((_, reject) => {
                        cancel = () => reject(new Error('Scan stopped.'));
                        signal.addEventListener('abort', cancel, { once: true });
                        if (signal.aborted) cancel();
                        timeout = setTimeout(() => reject(new Error('Market data request timed out.')), 15000);
                    }),
                ]);
            } finally {
                clearTimeout(timeout);
                signal.removeEventListener('abort', cancel);
            }
        };
        const run = async () => {
            let round = 0;
            while (!signal.aborted) {
                try {
                    setMessage('Connecting to market data…');
                    api = await generateDerivApiInstance({ publicOnly: true });
                    if (signal.aborted) {
                        api.disconnect();
                        return;
                    }
                    const response = await request({ active_symbols: 'brief' });
                    if (signal.aborted) return;
                    const markets: Market[] = (response.active_symbols || []).filter(
                        (market: Market & { exchange_is_open: number; is_trading_suspended: number }) =>
                            /^(R_\d+|1HZ\d+V)$/.test(market.symbol) &&
                            market.exchange_is_open &&
                            !market.is_trading_suspended
                    );
                    if (!markets.length) throw new Error('No available Volatility markets.');
                    // Keep polling in paced rounds; no tick subscriptions or trading requests.
                    round++;
                    for (const [index, market] of markets.entries()) {
                        if (signal.aborted) return;
                        setMessage(`Scanning ${index + 1}/${markets.length} · Round ${round} · ${market.display_name}`);
                        try {
                            const history = await request({
                                ticks_history: market.symbol,
                                style: 'ticks',
                                end: 'latest',
                                count: sampleSize,
                            });
                            if (signal.aborted) return;
                            if (!Array.isArray(history.history?.prices) || !Number.isInteger(history.pip_size))
                                throw new Error('Missing history');
                            const digits = (history.history.prices as number[])
                                .map(price => lastDigit(price, history.pip_size))
                                .filter((digit): digit is number => digit !== null)
                                .slice(-sampleSize);
                            if (digits.length !== sampleSize) throw new Error('Incomplete history');
                            // Evaluate both directions against the same snapshot and API request.
                            const snapshot = { ...market, digits, checkedAt: Date.now() };
                            const evaluations = (['over', 'under'] as const).map(side => ({
                                ...snapshot,
                                ...evaluateScan(digits, side, sampleSize),
                                side,
                            }));
                            const matches = evaluations.filter(result => result.matches);
                            setPreview({ ...evaluations[0], matchedSides: matches.map(result => result.side) });
                            setResults(previous => [
                                ...previous.filter(
                                    item => item.symbol !== market.symbol && Date.now() - item.checkedAt < 60000
                                ),
                                ...matches,
                            ]);
                        } catch {
                            if (signal.aborted) return;
                            setResults(previous =>
                                previous.filter(
                                    item => item.symbol !== market.symbol && Date.now() - item.checkedAt < 60000
                                )
                            );
                            setPreview(previous => (previous?.symbol === market.symbol ? undefined : previous));
                            setMessage(`${market.display_name}: data unavailable; retrying next round.`);
                        }
                        await delay(1000, signal);
                    }
                    await delay(2000, signal);
                    // Refresh availability each round as well as every market's snapshot.
                } catch (error) {
                    if (signal.aborted) return;
                    setResults([]);
                    setPreview(undefined);
                    setMessage(
                        `${error instanceof Error ? error.message : 'Market connection unavailable.'} Retrying in 5 seconds…`
                    );
                    await delay(5000, signal);
                } finally {
                    api?.disconnect();
                    api = undefined;
                }
            }
        };
        void run();
        return () => {
            controller.abort();
            api?.disconnect();
        };
    }, [active, enabled, sampleSize]);
    return (
        <section className='digit-scanner' aria-labelledby='digit-scanner-title'>
            <h2 id='digit-scanner-title'>Over / Under market scanner</h2>
            <p>
                Automatically checks both Over and Under conditions on every Volatility market using the last{' '}
                {sampleSize.toLocaleString()} ticks. Matches are refreshed on each pass.
            </p>
            <div className='digit-scanner__controls'>
                <button onClick={() => setEnabled(value => !value)}>{enabled ? 'PAUSE' : 'RESUME'}</button>
            </div>
            <p className='digit-scanner__rules'>
                Over: digits 0–3 each below 10%, red (least frequent) on 0–3, green (most frequent) on 6–9. Under:
                digits 6–9 each below 10%, red on 6–9, green on 0–3. All tied marks must stay within their required
                group.
            </p>
            <p role='status' aria-live='polite'>
                {message}
            </p>
            {preview && (
                <div className='digit-scanner__preview'>
                    <h3>Checking: {preview.display_name}</h3>
                    <p>
                        Last checked {new Date(preview.checkedAt).toLocaleTimeString()} · {preview.digits.length} ticks
                        ·{' '}
                        {preview.matchedSides.length
                            ? `${preview.matchedSides.map(side => (side === 'over' ? 'Over' : 'Under')).join(' / ')} conditions matched`
                            : 'Neither Over nor Under conditions matched'}
                    </p>
                    <div className='digit-scanner__circles' aria-label='Scanner digit percentages'>
                        {digitFrequencies(preview.digits).map((item, digit) => (
                            <div
                                key={digit}
                                className={`digit-scanner__circle${preview.redDigits.includes(digit) ? ' digit-scanner__circle--red' : ''}${preview.greenDigits.includes(digit) ? ' digit-scanner__circle--green' : ''}`}
                                aria-label={`Digit ${digit}: ${item.percent.toFixed(1)} percent${preview.redDigits.includes(digit) ? ', least frequent' : ''}${preview.greenDigits.includes(digit) ? ', most frequent' : ''}`}
                            >
                                <strong>{digit}</strong>
                                <span>{item.percent.toFixed(1)}%</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {loadError && <p role='alert'>{loadError}</p>}
            {results.length > 0 && (
                <h3 className='digit-scanner__found' role='status'>
                    Market found · {results.length} {results.length === 1 ? 'match' : 'matches'}
                </h3>
            )}
            <div className='digit-scanner__results'>
                {results.map(result => (
                    <article key={`${result.symbol}-${result.side}`}>
                        <h3>
                            {result.display_name} · {result.side === 'over' ? 'Over' : 'Under'}
                        </h3>
                        <p>{result.selected.map(item => `${item.digit}: ${item.percent.toFixed(2)}%`).join(' · ')}</p>
                        <p>
                            Red: {result.redDigits.join(', ')} · Green: {result.greenDigits.join(', ')}
                        </p>
                        <p>Last matched {new Date(result.checkedAt).toLocaleTimeString()}. Conditions may change.</p>
                        <p>
                            Suggested bot:{' '}
                            <strong>{result.side === 'over' ? 'Over Punisher' : 'Under Punisher'}</strong>
                        </p>
                        <div className='digit-scanner__actions'>
                            <button onClick={() => onSelect(result.symbol)}>View digits</button>
                            <button
                                onClick={() => {
                                    try {
                                        if (onLoad(result.side, result.symbol, result.submarket || 'random_index')) {
                                            setLoadError('');
                                        }
                                    } catch (error) {
                                        setLoadError(
                                            error instanceof Error ? error.message : 'Unable to load this bot.'
                                        );
                                    }
                                }}
                            >
                                Load Bot
                            </button>
                        </div>
                    </article>
                ))}
            </div>
            <p>
                The scanner pauses when you leave this tab. Loading selects the matched market in Bot Builder; review
                your settings before running. Historical matches do not predict the next digit.
            </p>
        </section>
    );
}
