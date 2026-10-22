import { useEffect, useState } from 'react';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { digitFrequencies, lastDigit } from './digits';
import MarketScanner from './market-scanner';
import './digit-analysis.scss';

type Market = {
    symbol: string;
    display_name: string;
    market: string;
    exchange_is_open: number;
    is_trading_suspended: number;
};
type Tick = { quote: number; epoch: number; pip_size: number; symbol?: string; underlying_symbol?: string };

export default function DigitAnalysis({ active = true }: { active?: boolean }) {
    const panelRef = useMarketPanelHeight<HTMLElement>({ enabled: active });
    const [markets, setMarkets] = useState<Market[]>([]);
    const [symbol, setSymbol] = useState('R_100');
    const [sampleSize, setSampleSize] = useState(1000);
    const [digits, setDigits] = useState<number[]>([]);
    const [latest, setLatest] = useState('');
    const [status, setStatus] = useState('Connecting to market…');
    const [error, setError] = useState('');
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let disposed = false;
        let failed = false;
        let api: Awaited<ReturnType<typeof generateDerivApiInstance>>;
        let listener: { unsubscribe: () => void } | undefined;
        let historyReady = false;
        let snapshotEpoch = 0;
        const queued: Tick[] = [];
        setDigits([]);
        setLatest('');
        setError('');
        setStatus('Connecting to market…');
        const fail = (message: string) => {
            if (!disposed && !failed) {
                failed = true;
                setError(message);
                setStatus('Disconnected');
            }
        };
        const acceptTick = (tick: Tick) => {
            if (disposed || tick.epoch <= snapshotEpoch) return;
            const digit = lastDigit(tick.quote, tick.pip_size);
            if (digit === null) return;
            setDigits(previous => [...previous, digit].slice(-sampleSize));
            setLatest(Number(tick.quote).toFixed(tick.pip_size));
            setStatus('Live');
        };
        const connect = async () => {
            api = await generateDerivApiInstance({ publicOnly: true });
            if (disposed) {
                api.disconnect();
                return;
            }
            api.connection.addEventListener('close', () =>
                fail('Market connection closed. Reconnect to resume live analysis.')
            );
            api.connection.addEventListener('error', () => fail('Unable to connect to live market data.'));
            listener = api.onMessage().subscribe(({ data }: { data: { tick?: Tick } }) => {
                if (disposed || failed || !data.tick) return;
                const tickSymbol = data.tick.symbol || data.tick.underlying_symbol;
                if (tickSymbol && tickSymbol !== symbol) return;
                if (!historyReady) queued.push(data.tick);
                else acceptTick(data.tick);
            });
            const [symbols, history] = await Promise.all([
                api.send({ active_symbols: 'brief' }),
                api.send({ ticks_history: symbol, style: 'ticks', end: 'latest', count: sampleSize, subscribe: 1 }),
            ]);
            if (disposed) return;
            setMarkets(
                symbols.active_symbols.filter(
                    (market: Market) =>
                        market.market === 'synthetic_index' && market.exchange_is_open && !market.is_trading_suspended
                )
            );
            const precision = history.pip_size;
            if (!Array.isArray(history.history?.prices) || !Number.isInteger(precision))
                throw new Error('Market history is unavailable. Select another market or reconnect.');
            const prices = history.history.prices as number[];
            setDigits(
                prices
                    .map(price => lastDigit(price, precision))
                    .filter((digit): digit is number => digit !== null)
                    .slice(-sampleSize)
            );
            if (prices.length) setLatest(Number(prices[prices.length - 1]).toFixed(precision));
            snapshotEpoch = history.history.times?.at(-1) || 0;
            historyReady = true;
            setStatus('Live');
            queued.forEach(acceptTick);
        };
        connect().catch(reason => {
            fail(reason?.message || 'Unable to load market data. Please reconnect.');
            listener?.unsubscribe();
            api?.disconnect();
        });
        return () => {
            disposed = true;
            listener?.unsubscribe();
            api?.disconnect();
        };
    }, [symbol, sampleSize, retry]);

    const frequencies = digitFrequencies(digits);
    const highest = Math.max(...frequencies.map(item => item.count));
    const lowest = Math.min(...frequencies.map(item => item.count));
    const latestDigit = digits.at(-1);
    const marketName = markets.find(market => market.symbol === symbol)?.display_name || symbol;
    return (
        <section className='digit-analysis' aria-labelledby='digit-analysis-title' ref={panelRef} tabIndex={0}>
            <div className='digit-analysis__heading'>
                <div>
                    <p className='digit-analysis__eyebrow'>LIVE MARKET STATISTICS</p>
                    <h1 id='digit-analysis-title'>Digit Analysis</h1>
                    <p>See how often each last digit appears in the latest market ticks.</p>
                </div>
                <span
                    className={`digit-analysis__status${error ? ' digit-analysis__status--offline' : ''}`}
                    role='status'
                >
                    {status}
                </span>
            </div>
            <div className='digit-analysis__controls'>
                <label>
                    Market
                    <select value={symbol} onChange={event => setSymbol(event.target.value)}>
                        {!markets.some(market => market.symbol === symbol) && (
                            <option value={symbol}>{marketName}</option>
                        )}
                        {markets.map(market => (
                            <option key={market.symbol} value={market.symbol}>
                                {market.display_name}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    Sample size
                    <select value={sampleSize} onChange={event => setSampleSize(Number(event.target.value))}>
                        {[100, 500, 1000].map(size => (
                            <option key={size} value={size}>
                                Last {size.toLocaleString()} ticks
                            </option>
                        ))}
                    </select>
                </label>
                <div className='digit-analysis__quote'>
                    <span>Latest quote</span>
                    <strong>{latest || '—'}</strong>
                </div>
                <div className='digit-analysis__quote'>
                    <span>Ticks in sample</span>
                    <strong>
                        {digits.length.toLocaleString()} / {sampleSize.toLocaleString()}
                    </strong>
                </div>
            </div>
            {error && (
                <div className='digit-analysis__error' role='alert'>
                    {error}
                    <button onClick={() => setRetry(value => value + 1)}>Reconnect</button>
                </div>
            )}
            <div className='digit-analysis__grid' aria-label='Last-digit frequencies'>
                {frequencies.map((item, digit) => {
                    const high = digits.length > 0 && highest !== lowest && item.count === highest;
                    const low = digits.length > 0 && highest !== lowest && item.count === lowest;
                    return (
                        <div
                            key={digit}
                            className={`digit-analysis__digit${high ? ' digit-analysis__digit--high' : ''}${low ? ' digit-analysis__digit--low' : ''}${latestDigit === digit ? ' digit-analysis__digit--latest' : ''}`}
                        >
                            <div
                                className='digit-analysis__circle'
                                aria-label={`Digit ${digit}: ${item.percent.toFixed(1)} percent, ${item.count} ticks`}
                            >
                                <strong>{digit}</strong>
                                <span>{item.percent.toFixed(1)}%</span>
                            </div>
                            <span className='digit-analysis__count'>{item.count} ticks</span>
                            <span className='digit-analysis__marker'>
                                {latestDigit === digit
                                    ? 'Latest digit'
                                    : high
                                      ? 'Most frequent'
                                      : low
                                        ? 'Least frequent'
                                        : '\u00a0'}
                            </span>
                        </div>
                    );
                })}
            </div>
            <div className='digit-analysis__legend'>
                <span>
                    <i className='digit-analysis__key digit-analysis__key--high' />
                    Most frequent
                </span>
                <span>
                    <i className='digit-analysis__key digit-analysis__key--low' />
                    Least frequent
                </span>
                <span>
                    <i className='digit-analysis__key' />
                    Latest digit
                </span>
            </div>
            <MarketScanner sampleSize={sampleSize} onSelect={setSymbol} />
            <p className='digit-analysis__note'>
                Percentages describe the selected rolling sample of past ticks. They do not predict the next digit or
                guarantee a trading outcome.
            </p>
        </section>
    );
}
